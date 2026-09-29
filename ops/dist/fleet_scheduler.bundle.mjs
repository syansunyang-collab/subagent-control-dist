#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// ops/node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError;
var init_error = __esm({
  "ops/node_modules/smol-toml/dist/error.js"() {
    TomlError = class extends Error {
      line;
      column;
      codeblock;
      constructor(message, options) {
        const [line, column] = getLineColFromPtr(options.toml, options.ptr);
        const codeblock = makeCodeBlock(options.toml, line, column);
        super(`Invalid TOML document: ${message}

${codeblock}`, options);
        this.line = line;
        this.column = column;
        this.codeblock = codeblock;
      }
    };
  }
});

// ops/node_modules/smol-toml/dist/util.js
function isEscaped(str, ptr) {
  let i = 0;
  while (str[ptr - ++i] === "\\")
    ;
  return --i && i % 2;
}
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf("\n", start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "\n")
      return i;
    if (c === "\r" && str[i + 1] === "\n")
      return i + 1;
    if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
    }
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c;
  while ((c = str[ptr]) === " " || c === "	" || !banNewLines && (c === "\n" || c === "\r" && str[ptr + 1] === "\n"))
    ptr++;
  return banComments || c !== "#" ? ptr : skipVoid(str, skipComment(str, ptr), banNewLines);
}
function skipUntil(str, ptr, sep, end, banNewLines = false) {
  if (!end) {
    ptr = indexOfNewline(str, ptr);
    return ptr < 0 ? str.length : ptr;
  }
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "#") {
      i = indexOfNewline(str, i);
    } else if (c === sep) {
      return i + 1;
    } else if (c === end || banNewLines && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      return i;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}
function getStringEnd(str, seek) {
  let first = str[seek];
  let target = first === str[seek + 1] && str[seek + 1] === str[seek + 2] ? str.slice(seek, seek + 3) : first;
  seek += target.length - 1;
  do
    seek = str.indexOf(target, ++seek);
  while (seek > -1 && first !== "'" && isEscaped(str, seek));
  if (seek > -1) {
    seek += target.length;
    if (target.length > 1) {
      if (str[seek] === first)
        seek++;
      if (str[seek] === first)
        seek++;
    }
  }
  return seek;
}
var init_util = __esm({
  "ops/node_modules/smol-toml/dist/util.js"() {
    init_error();
  }
});

// ops/node_modules/smol-toml/dist/date.js
var DATE_TIME_RE, TomlDate;
var init_date = __esm({
  "ops/node_modules/smol-toml/dist/date.js"() {
    DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}:\d{2}(?:\.\d+)?)?(Z|[-+]\d{2}:\d{2})?$/i;
    TomlDate = class _TomlDate extends Date {
      #hasDate = false;
      #hasTime = false;
      #offset = null;
      constructor(date) {
        let hasDate = true;
        let hasTime = true;
        let offset = "Z";
        if (typeof date === "string") {
          let match = date.match(DATE_TIME_RE);
          if (match) {
            if (!match[1]) {
              hasDate = false;
              date = `0000-01-01T${date}`;
            }
            hasTime = !!match[2];
            hasTime && date[10] === " " && (date = date.replace(" ", "T"));
            if (match[2] && +match[2] > 23) {
              date = "";
            } else {
              offset = match[3] || null;
              date = date.toUpperCase();
              if (!offset && hasTime)
                date += "Z";
            }
          } else {
            date = "";
          }
        }
        super(date);
        if (!isNaN(this.getTime())) {
          this.#hasDate = hasDate;
          this.#hasTime = hasTime;
          this.#offset = offset;
        }
      }
      isDateTime() {
        return this.#hasDate && this.#hasTime;
      }
      isLocal() {
        return !this.#hasDate || !this.#hasTime || !this.#offset;
      }
      isDate() {
        return this.#hasDate && !this.#hasTime;
      }
      isTime() {
        return this.#hasTime && !this.#hasDate;
      }
      isValid() {
        return this.#hasDate || this.#hasTime;
      }
      toISOString() {
        let iso = super.toISOString();
        if (this.isDate())
          return iso.slice(0, 10);
        if (this.isTime())
          return iso.slice(11, 23);
        if (this.#offset === null)
          return iso.slice(0, -1);
        if (this.#offset === "Z")
          return iso;
        let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
        offset = this.#offset[0] === "-" ? offset : -offset;
        let offsetDate = new Date(this.getTime() - offset * 6e4);
        return offsetDate.toISOString().slice(0, -1) + this.#offset;
      }
      static wrapAsOffsetDateTime(jsDate, offset = "Z") {
        let date = new _TomlDate(jsDate);
        date.#offset = offset;
        return date;
      }
      static wrapAsLocalDateTime(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#offset = null;
        return date;
      }
      static wrapAsLocalDate(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#hasTime = false;
        date.#offset = null;
        return date;
      }
      static wrapAsLocalTime(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#hasDate = false;
        date.#offset = null;
        return date;
      }
    };
  }
});

// ops/node_modules/smol-toml/dist/primitive.js
function parseString(str, ptr = 0, endPtr = str.length) {
  let isLiteral = str[ptr] === "'";
  let isMultiline = str[ptr++] === str[ptr] && str[ptr] === str[ptr + 1];
  if (isMultiline) {
    endPtr -= 2;
    if (str[ptr += 2] === "\r")
      ptr++;
    if (str[ptr] === "\n")
      ptr++;
  }
  let tmp = 0;
  let isEscape;
  let parsed = "";
  let sliceStart = ptr;
  while (ptr < endPtr - 1) {
    let c = str[ptr++];
    if (c === "\n" || c === "\r" && str[ptr] === "\n") {
      if (!isMultiline) {
        throw new TomlError("newlines are not allowed in strings", {
          toml: str,
          ptr: ptr - 1
        });
      }
    } else if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: ptr - 1
      });
    }
    if (isEscape) {
      isEscape = false;
      if (c === "u" || c === "U") {
        let code = str.slice(ptr, ptr += c === "u" ? 4 : 8);
        if (!ESCAPE_REGEX.test(code)) {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
        try {
          parsed += String.fromCodePoint(parseInt(code, 16));
        } catch {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
      } else if (isMultiline && (c === "\n" || c === " " || c === "	" || c === "\r")) {
        ptr = skipVoid(str, ptr - 1, true);
        if (str[ptr] !== "\n" && str[ptr] !== "\r") {
          throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
            toml: str,
            ptr: tmp
          });
        }
        ptr = skipVoid(str, ptr);
      } else if (c in ESC_MAP) {
        parsed += ESC_MAP[c];
      } else {
        throw new TomlError("unrecognized escape sequence", {
          toml: str,
          ptr: tmp
        });
      }
      sliceStart = ptr;
    } else if (!isLiteral && c === "\\") {
      tmp = ptr - 1;
      isEscape = true;
      parsed += str.slice(sliceStart, tmp);
    }
  }
  return parsed + str.slice(sliceStart, endPtr - 1);
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid()) {
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  }
  return date;
}
var INT_REGEX, FLOAT_REGEX, LEADING_ZERO, ESCAPE_REGEX, ESC_MAP;
var init_primitive = __esm({
  "ops/node_modules/smol-toml/dist/primitive.js"() {
    init_util();
    init_date();
    init_error();
    INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
    FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
    LEADING_ZERO = /^[+-]?0[0-9_]/;
    ESCAPE_REGEX = /^[0-9a-f]{4,8}$/i;
    ESC_MAP = {
      b: "\b",
      t: "	",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\"
    };
  }
});

// ops/node_modules/smol-toml/dist/extract.js
function sliceAndTrimEndOf(str, startPtr, endPtr, allowNewLines) {
  let value = str.slice(startPtr, endPtr);
  let commentIdx = value.indexOf("#");
  if (commentIdx > -1) {
    skipComment(str, commentIdx);
    value = value.slice(0, commentIdx);
  }
  let trimmed = value.trimEnd();
  if (!allowNewLines) {
    let newlineIdx = value.indexOf("\n", trimmed.length);
    if (newlineIdx > -1) {
      throw new TomlError("newlines are not allowed in inline tables", {
        toml: str,
        ptr: startPtr + newlineIdx
      });
    }
  }
  return [trimmed, commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0) {
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  }
  let c = str[ptr];
  if (c === "[" || c === "{") {
    let [value, endPtr2] = c === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    let newPtr = end ? skipUntil(str, endPtr2, ",", end) : endPtr2;
    if (endPtr2 - newPtr && end === "}") {
      let nextNewLine = indexOfNewline(str, endPtr2, newPtr);
      if (nextNewLine > -1) {
        throw new TomlError("newlines are not allowed in inline tables", {
          toml: str,
          ptr: nextNewLine
        });
      }
    }
    return [value, newPtr];
  }
  let endPtr;
  if (c === '"' || c === "'") {
    endPtr = getStringEnd(str, ptr);
    let parsed = parseString(str, ptr, endPtr);
    if (end) {
      endPtr = skipVoid(str, endPtr, end !== "]");
      if (str[endPtr] && str[endPtr] !== "," && str[endPtr] !== end && str[endPtr] !== "\n" && str[endPtr] !== "\r") {
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr
        });
      }
      endPtr += +(str[endPtr] === ",");
    }
    return [parsed, endPtr];
  }
  endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - +(str[endPtr - 1] === ","), end === "]");
  if (!slice[0]) {
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  }
  if (end && slice[1] > -1) {
    endPtr = skipVoid(str, ptr + slice[1]);
    endPtr += +(str[endPtr] === ",");
  }
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}
var init_extract = __esm({
  "ops/node_modules/smol-toml/dist/extract.js"() {
    init_primitive();
    init_struct();
    init_util();
    init_error();
  }
});

// ops/node_modules/smol-toml/dist/struct.js
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1;
  let parsed = [];
  let endPtr = str.indexOf(end, ptr);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  }
  do {
    let c = str[ptr = ++dot];
    if (c !== " " && c !== "	") {
      if (c === '"' || c === "'") {
        if (c === str[ptr + 1] && c === str[ptr + 2]) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        }
        let eos = getStringEnd(str, ptr);
        if (eos < 0) {
          throw new TomlError("unfinished string encountered", {
            toml: str,
            ptr
          });
        }
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        }
        if (endPtr < eos) {
          endPtr = str.indexOf(end, eos);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
          }
        }
        parsed.push(parseString(str, ptr, eos));
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, true, true)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  let comma = 0;
  ptr++;
  while ((c = str[ptr++]) !== "}" && c) {
    let err = { toml: str, ptr: ptr - 1 };
    if (c === "\n") {
      throw new TomlError("newlines are not allowed in inline tables", err);
    } else if (c === "#") {
      throw new TomlError("inline tables cannot contain comments", err);
    } else if (c === ",") {
      throw new TomlError("expected key-value, found comma", err);
    } else if (c !== " " && c !== "	") {
      let k;
      let t = res;
      let hasOwn = false;
      let [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i = 0; i < key.length; i++) {
        if (i)
          t = hasOwn ? t[k] : t[k] = {};
        k = key[i];
        if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        }
        if (!hasOwn && k === "__proto__") {
          Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        }
      }
      if (hasOwn) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      }
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value);
      t[k] = value;
      ptr = valueEndPtr;
      comma = str[ptr - 1] === "," ? ptr - 1 : 0;
    }
  }
  if (comma) {
    throw new TomlError("trailing commas are not allowed in inline tables", {
      toml: str,
      ptr: comma
    });
  }
  if (!c) {
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [];
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "]" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let e = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e[0]);
      ptr = e[1];
    }
  }
  if (!c) {
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
var KEY_PART_RE;
var init_struct = __esm({
  "ops/node_modules/smol-toml/dist/struct.js"() {
    init_primitive();
    init_extract();
    init_util();
    init_error();
    KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
  }
});

// ops/node_modules/smol-toml/dist/parse.js
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let res = {};
  let meta = {};
  let tbl = res;
  let m = meta;
  for (let ptr = skipVoid(toml, 0); ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[";
      let k = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k[1] - 1] !== "]") {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k[1] - 1
          });
        }
        k[1]++;
      }
      let p = peekTable(
        k[0],
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      m = p[2];
      tbl = p[1];
      ptr = k[1];
    } else {
      let k = parseKey(toml, ptr);
      let p = peekTable(
        k[0],
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      let v = extractValue(toml, k[1], void 0, maxDepth, integersAsBigInt);
      p[1][p[0]] = v[0];
      ptr = v[1];
    }
    ptr = skipVoid(toml, ptr, true);
    if (toml[ptr] && toml[ptr] !== "\n" && toml[ptr] !== "\r") {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    }
    ptr = skipVoid(toml, ptr);
  }
  return res;
}
var init_parse = __esm({
  "ops/node_modules/smol-toml/dist/parse.js"() {
    init_struct();
    init_extract();
    init_util();
    init_error();
  }
});

// ops/node_modules/smol-toml/dist/stringify.js
var init_stringify = __esm({
  "ops/node_modules/smol-toml/dist/stringify.js"() {
  }
});

// ops/node_modules/smol-toml/dist/index.js
var init_dist = __esm({
  "ops/node_modules/smol-toml/dist/index.js"() {
    init_parse();
    init_stringify();
    init_date();
    init_error();
  }
});

// ops/tools/model_config.mjs
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process2 from "node:process";
function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function samePath(left, right) {
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process2.platform === "win32" ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US") : normalizedLeft === normalizedRight;
}
function isInsideProject(target, projectRoot2) {
  const normalizedTarget = process2.platform === "win32" ? path.resolve(target).toLocaleLowerCase("en-US") : path.resolve(target);
  const normalizedRoot = process2.platform === "win32" ? path.resolve(projectRoot2).toLocaleLowerCase("en-US") : path.resolve(projectRoot2);
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}
function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}
function assetExists(target, key) {
  return MODEL_CONFIG_ASSETS[key].kind === "dir" ? isDirectory(target) : isFile(target);
}
function globalModelConfigAssetPath(root, key) {
  if (!MODEL_CONFIG_ASSETS[key]) throw new ModelConfigError(`\u672A\u77E5\u7684\u6A21\u578B\u914D\u7F6E\u8D44\u4EA7\uFF1A${key}`);
  return path.join(path.resolve(String(root)), ...MODEL_CONFIG_ASSETS[key].relative);
}
function inspectGlobalModelConfig(root) {
  const resolved = path.resolve(String(root));
  const missing = MODEL_CONFIG_REQUIRED_KEYS.filter((key) => !assetExists(globalModelConfigAssetPath(resolved, key), key));
  return { root: resolved, complete: missing.length === 0, missing };
}
function resolveGlobalModelConfigRoot({ roots = [] } = {}) {
  const inspected = [];
  for (const entry of roots) {
    const raw = typeof entry === "string" ? entry : entry?.root;
    if (!text(raw)) continue;
    const source = typeof entry === "string" ? "runtime_root" : String(entry?.source || "runtime_root");
    const inspection = inspectGlobalModelConfig(raw);
    if (inspection.complete) return { root: inspection.root, source };
    if (inspected.some((item) => samePath(item.root, inspection.root))) continue;
    inspected.push({ root: inspection.root, source, missing: inspection.missing });
  }
  const detail = inspected.length ? inspected.map((item) => `${item.root}\uFF08${item.source}\uFF09\u7F3A\u5C11 ${item.missing.join(", ")}`).join("\uFF1B") : "\u6CA1\u6709\u53EF\u7528\u7684\u5019\u9009\u8FD0\u884C\u6839";
  throw new ModelConfigError(
    `\u5168\u5C40\u89D2\u8272/\u6A21\u578B\u914D\u7F6E\u4E0D\u5B8C\u6574\uFF1A${detail}\u3002\u8BF7\u90E8\u7F72\u5E26 ops/agents \u4E0E ops/model-notes.toml \u7684\u8FD0\u884C\u5305\u3002`
  );
}
function modelConfigDeclarationPath(projectRoot2) {
  return path.join(path.resolve(String(projectRoot2)), ...MODEL_CONFIG_DECLARATION_SEGMENTS);
}
function declarationPathValue(declaration, key, declarationPath) {
  const value = declaration[key];
  if (!text(value)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\uFF1A${declarationPath}`);
  }
  const raw = value.trim();
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\")) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u5FC5\u987B\u662F\u9879\u76EE\u5185\u76F8\u5BF9\u8DEF\u5F84\uFF1A${declarationPath}\uFF1A${raw}`);
  }
  const segments = raw.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u4E0D\u5F97\u8D8A\u51FA\u9879\u76EE\u6839\uFF1A${declarationPath}\uFF1A${raw}`);
  }
  return segments.join("/");
}
function readModelConfigDeclaration(projectRoot2) {
  const declarationPath = modelConfigDeclarationPath(projectRoot2);
  if (!existsSync(declarationPath)) {
    return { path: declarationPath, exists: false, overrides: {}, declared_keys: [] };
  }
  if (!isFile(declarationPath)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u5FC5\u987B\u662F\u666E\u901A\u6587\u4EF6\uFF1A${declarationPath}`);
  }
  let raw;
  try {
    raw = readFileSync(declarationPath, "utf8");
  } catch (error) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u4E0D\u53EF\u8BFB\uFF1A${declarationPath}\uFF1A${error?.message ?? error}`);
  }
  let declaration;
  try {
    declaration = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u4E0D\u662F\u6709\u6548 JSON\uFF1A${declarationPath}\uFF1A${error?.message ?? error}`);
  }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u5FC5\u987B\u662F JSON \u5BF9\u8C61\uFF1A${declarationPath}`);
  }
  if (declaration.schema_version !== MODEL_CONFIG_SCHEMA_VERSION) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E schema_version \u5FC5\u987B\u4E3A ${MODEL_CONFIG_SCHEMA_VERSION}\uFF1A${declarationPath}`
    );
  }
  const unknown = Object.keys(declaration).filter((key) => key !== "schema_version" && !MODEL_CONFIG_ASSETS[key]);
  if (unknown.length > 0) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u542B\u672A\u77E5\u5B57\u6BB5 ${unknown.join(", ")}\uFF1A${declarationPath}\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${MODEL_CONFIG_ASSET_KEYS.join(", ")}`
    );
  }
  const declaredKeys = MODEL_CONFIG_ASSET_KEYS.filter((key) => declaration[key] !== void 0);
  if (declaredKeys.length === 0) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u672A\u9009\u62E9\u4EFB\u4F55\u8D44\u4EA7\uFF1A${declarationPath}\uFF1B\u81F3\u5C11\u58F0\u660E ${MODEL_CONFIG_ASSET_KEYS.join(" / ")} \u4E4B\u4E00`
    );
  }
  const project = path.resolve(String(projectRoot2));
  const overrides = {};
  for (const key of declaredKeys) {
    const relative = declarationPathValue(declaration, key, declarationPath);
    const resolved = path.resolve(project, ...relative.split("/"));
    if (!isInsideProject(resolved, project)) {
      throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u8D8A\u51FA\u9879\u76EE\u6839\uFF1A${declarationPath}\uFF1A${relative}`);
    }
    if (!assetExists(resolved, key)) {
      throw new ModelConfigError(
        `\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u6307\u5411\u7684${MODEL_CONFIG_ASSETS[key].kind === "dir" ? "\u76EE\u5F55" : "\u6587\u4EF6"}\u4E0D\u5B58\u5728\uFF1A${declarationPath}\uFF1A${relative}`
      );
    }
    overrides[key] = resolved;
  }
  return { path: declarationPath, exists: true, overrides, declared_keys: declaredKeys };
}
function resolveModelConfigSources({ roots = [], projectRoot: projectRoot2 } = {}) {
  if (!text(projectRoot2)) {
    throw new ModelConfigError("\u89E3\u6790\u6A21\u578B\u914D\u7F6E\u6765\u6E90\u9700\u8981\u9879\u76EE\u6839");
  }
  const global = resolveGlobalModelConfigRoot({ roots });
  const declaration = readModelConfigDeclaration(projectRoot2);
  const assets = {};
  const sources = {};
  for (const key of MODEL_CONFIG_ASSET_KEYS) {
    const declared = declaration.overrides[key];
    assets[key] = declared ?? globalModelConfigAssetPath(global.root, key);
    sources[key] = declared ? "project_declaration" : "global_default";
  }
  return {
    global_root: global.root,
    global_source: global.source,
    declaration_path: declaration.path,
    project_override: Object.keys(declaration.overrides).length > 0,
    declared_keys: declaration.declared_keys,
    agents_dir: assets.agents_dir,
    model_notes: assets.model_notes,
    sources,
    /** 角色 TOML 路径；角色名只做路径拼接，合法性由调用方既有的角色名校验负责。 */
    roleConfigPath(role) {
      const name = `${String(role ?? "").trim()}.toml`;
      const selected = path.join(assets.agents_dir, name);
      return declaration.overrides.agents_dir && !existsSync(selected) ? path.join(global.root, "ops", "agents", name) : selected;
    },
    /** 来源诊断：父进程选型与 runner 验收共用同一份字段。 */
    describe() {
      return {
        global_root: global.root,
        global_source: global.source,
        declaration_path: declaration.path,
        project_override: Object.keys(declaration.overrides).length > 0,
        declared_keys: [...declaration.declared_keys],
        agents_dir: assets.agents_dir,
        model_notes: assets.model_notes,
        sources: { ...sources }
      };
    }
  };
}
var MODEL_CONFIG_DECLARATION_SEGMENTS, MODEL_CONFIG_SCHEMA_VERSION, MODEL_CONFIG_ASSETS, MODEL_CONFIG_ASSET_KEYS, MODEL_CONFIG_REQUIRED_KEYS, ModelConfigError;
var init_model_config = __esm({
  "ops/tools/model_config.mjs"() {
    MODEL_CONFIG_DECLARATION_SEGMENTS = Object.freeze([".pi", "control-plane-model-config.json"]);
    MODEL_CONFIG_SCHEMA_VERSION = 1;
    MODEL_CONFIG_ASSETS = Object.freeze({
      agents_dir: Object.freeze({ kind: "dir", relative: Object.freeze(["ops", "agents"]) }),
      model_notes: Object.freeze({ kind: "file", relative: Object.freeze(["ops", "model-notes.toml"]) })
    });
    MODEL_CONFIG_ASSET_KEYS = Object.freeze(Object.keys(MODEL_CONFIG_ASSETS));
    MODEL_CONFIG_REQUIRED_KEYS = Object.freeze(["agents_dir", "model_notes"]);
    ModelConfigError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "ModelConfigError";
        this.code = "MODEL_CONFIG_INVALID";
      }
    };
  }
});

// ops/tools/dispatch-core/_tool_common.mjs
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync as existsSync2,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  readSync,
  realpathSync,
  renameSync,
  statSync as statSync2,
  unlinkSync,
  writeSync
} from "node:fs";
import os from "node:os";
import path2 from "node:path";
import process3 from "node:process";
import { fileURLToPath } from "node:url";
function pyError(type, message) {
  const error = new Error(message);
  error.name = String(type);
  return error;
}
function withUuid4Bits(hex32) {
  let raw = BigInt(`0x${hex32}`);
  raw = raw & ~(0xFn << 76n) | 0x4n << 76n;
  raw = raw & ~(0x3n << 62n) | 0x2n << 62n;
  return raw.toString(16).padStart(32, "0");
}
function uuidFromSeed(seed, index) {
  return withUuid4Bits(createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 32));
}
function utcNow() {
  const now = clock.now();
  const base = now.toISOString().slice(0, 19);
  const micros = frozen?.micros ?? `${String(now.getUTCMilliseconds()).padStart(3, "0")}000`;
  const fraction = micros === "000000" ? "" : `.${micros}`;
  return `${base}${fraction}+00:00`;
}
function utcDateStamp() {
  const now = clock.now();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
}
function isAbsoluteLikePython(value) {
  const text3 = String(value ?? "");
  if (process3.platform !== "win32") return text3.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text3) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text3);
}
function pathlibJoin(base, other) {
  const text3 = String(other ?? "");
  if (isAbsoluteLikePython(text3)) return text3;
  if (process3.platform === "win32" && /^[\\/]/.test(text3)) {
    const drive = path2.parse(path2.resolve(String(base))).root.replace(/[\\/]+$/, "");
    return `${drive}${text3}`;
  }
  return path2.join(String(base), text3);
}
function resolveLikePython(value) {
  const absolute = path2.resolve(String(value));
  let current = absolute;
  const tail2 = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return tail2.length ? path2.join(real, ...tail2.reverse()) : real;
    } catch {
      const parent = path2.dirname(current);
      if (parent === current) return absolute;
      tail2.push(path2.basename(current));
      current = parent;
    }
  }
}
function repoRoot() {
  const explicit = String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (explicit) {
    if (!isAbsoluteLikePython(explicit)) throw new ToolError("SUBAGENT_CONTROL_REPO_ROOT must be an absolute path");
    const resolved = resolveLikePython(explicit);
    let info = null;
    try {
      info = statSync2(resolved);
    } catch {
      info = null;
    }
    if (!info || !info.isDirectory()) throw new ToolError(`SUBAGENT_CONTROL_REPO_ROOT is not a directory: ${explicit}`);
    return resolved;
  }
  const scriptRoot = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync2(path2.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  let cur = resolveLikePython(process3.cwd());
  while (true) {
    if (existsSync2(path2.join(cur, ".git")) || existsSync2(path2.join(cur, "AGENTS.md")) && existsSync2(path2.join(cur, "ops"))) {
      return cur;
    }
    const parent = path2.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new ToolError(`cannot locate cockpit repository root from ${resolveLikePython(process3.cwd())}`);
}
function declaredDirectory(envKey) {
  const explicit = String(process3.env[envKey] || "").trim();
  if (!explicit) return null;
  if (!isAbsoluteLikePython(explicit)) throw new ToolError(`${envKey} must be an absolute path`);
  const resolved = resolveLikePython(explicit);
  let info = null;
  try {
    info = statSync2(resolved);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) throw new ToolError(`${envKey} is not a directory: ${explicit}`);
  return resolved;
}
function projectRoot() {
  const explicit = declaredDirectory("SUBAGENT_PROJECT_ROOT");
  if (explicit) return explicit;
  if (String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd = resolveLikePython(process3.cwd());
  let cur = cwd;
  while (true) {
    if (existsSync2(path2.join(cur, ".git")) || existsSync2(path2.join(cur, "AGENTS.md")) && existsSync2(path2.join(cur, "ops"))) {
      return cur;
    }
    const parent = path2.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return repoRoot();
}
function runtimeRoot() {
  const explicit = declaredDirectory("SUBAGENT_RUNTIME_ROOT");
  if (explicit) return explicit;
  if (String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const scriptRoot = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync2(path2.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  return repoRoot();
}
function modelConfigSources() {
  if (!modelConfigCache) {
    try {
      modelConfigCache = resolveModelConfigSources({
        roots: [{ root: RUNTIME_ROOT, source: "runtime_root" }],
        projectRoot: ROOT
      });
    } catch (error) {
      if (error?.name === "ModelConfigError") throw new ToolError(error.message);
      throw error;
    }
  }
  return modelConfigCache;
}
function roleConfigPath(role) {
  const normalized = String(role ?? "").trim();
  if (!ROLE_NAME_RE.test(normalized)) throw new ToolError(`invalid runtime role: ${normalized || "(empty)"}`);
  return modelConfigSources().roleConfigPath(normalized);
}
function loadRoleConfig(role, { globalDefault = false } = {}) {
  const selectedFile = roleConfigPath(role);
  const file = globalDefault ? path2.join(modelConfigSources().global_root, "ops", "agents", path2.basename(selectedFile)) : selectedFile;
  let text3;
  try {
    text3 = readFileSync2(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ToolError(`runtime role config not found: ${rel(file)}`);
    throw new ToolError(`runtime role config is unreadable: ${rel(file)}`);
  }
  let data;
  try {
    data = parse(text3);
  } catch {
    throw new ToolError(`runtime role config is unreadable: ${rel(file)}`);
  }
  const declaredName = String(data.name ?? "").trim();
  const stem = path2.basename(file, ".toml");
  if (declaredName !== stem) {
    throw new ToolError(`runtime role name mismatch: ${rel(file)} declares ${declaredName || "(empty)"}`);
  }
  return data;
}
function rel(value) {
  const target = resolveLikePython(value);
  const relative = path2.relative(ROOT, target);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path2.isAbsolute(relative)) return String(value).replace(/\\/g, "/");
  return relative.replace(/\\/g, "/");
}
function loadJson(file) {
  let text3;
  try {
    text3 = readFileSync2(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ToolError(`json file not found: ${rel(file)}`);
    throw new ToolError(`cannot read json file: ${rel(file)}`);
  }
  let data;
  try {
    data = JSON.parse(text3);
  } catch (error) {
    throw new ToolError(`invalid json file: ${rel(file)}:${jsonErrorLine(text3, error)}`);
  }
  if (!isRecord(data)) throw new ToolError(`json root is not object: ${rel(file)}`);
  return data;
}
function jsonErrorLine(text3, error) {
  const match = /position (\d+)/.exec(String(error?.message ?? ""));
  if (!match) return 1;
  return text3.slice(0, Number(match[1])).split("\n").length;
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}
function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value), null, 2);
}
function emit(data, fmt, text3) {
  if (fmt === "json") {
    process3.stdout.write(`${canonicalJson(data)}
`);
  } else {
    const trimmed = String(text3 ?? "").replace(/\s+$/, "");
    process3.stdout.write(`${trimmed || "(empty)"}
`);
  }
  if (Object.hasOwn(data, "exit_code")) return Number(data.exit_code);
  return ["failed", "error"].includes(data.status) ? 1 : 0;
}
function normalizeConflictPath(value) {
  const raw = String(value ?? "").replace(/\\/g, "/").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const resolved = isAbsoluteLikePython(raw) ? resolveLikePython(raw) : resolveLikePython(pathlibJoin(ROOT, raw));
  const relative = path2.relative(resolveLikePython(ROOT), resolved);
  if (relative.startsWith("..") || path2.isAbsolute(relative)) return `external:${raw.toLowerCase()}`;
  return relative === "" ? "." : relative.replace(/\\/g, "/");
}
function pathConflict(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function lexicalAbsolute(value) {
  return path2.resolve(String(value));
}
function absolutePath(value, label, { error = ToolError } = {}) {
  const candidate = String(value);
  if (!isAbsoluteLikePython(candidate)) throw new error(`${label} must be absolute: ${value}`);
  return path2.resolve(candidate);
}
function isReparseStat(info) {
  return Boolean(info?.isSymbolicLink?.());
}
function componentsOf(candidate) {
  const parsed = path2.parse(candidate);
  const rest = candidate.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  return { anchor: parsed.root, parts: rest };
}
function assertNoReparseComponents(value, { allowMissing = false, label = "path", error = ToolError } = {}) {
  const candidate = absolutePath(value, label, { error });
  const { anchor, parts } = componentsOf(candidate);
  let current = anchor;
  for (const part of parts) {
    current = path2.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (caught) {
      if (caught?.code === "ENOENT") {
        if (allowMissing) return;
        throw new error(`${label} component does not exist: ${current}`);
      }
      throw new error(`cannot inspect ${label} component ${current}: ${caught.message}`);
    }
    if (info.isSymbolicLink() || isReparseStat(info)) throw new error(`symlink/reparse ${label} is not permitted: ${current}`);
  }
}
function ensureControlledDirectory(value, { mode = 448, label = "controlled directory", error = ToolError } = {}) {
  const candidate = absolutePath(value, label, { error });
  const { anchor, parts } = componentsOf(candidate);
  let current = anchor;
  for (const part of parts) {
    current = path2.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw new error(`cannot inspect ${label} ${current}: ${caught.message}`);
      try {
        mkdirSync(current, { mode });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw new error(`cannot create ${label} ${current}: ${mkdirError.message}`);
      }
      try {
        info = lstatSync(current);
      } catch (recheck) {
        throw new error(`cannot recheck ${label} ${current}: ${recheck.message}`);
      }
    }
    if (!info.isDirectory() || info.isSymbolicLink() || isReparseStat(info)) throw new error(`${label} is not a real directory: ${current}`);
  }
  return candidate;
}
function assertRegularFile(value, label, { error = ToolError } = {}) {
  const checked = absolutePath(value, label, { error });
  assertNoReparseComponents(path2.dirname(checked), { allowMissing: false, error });
  let info;
  try {
    info = lstatSync(checked);
  } catch {
    throw new error(`${label} is unavailable: ${checked}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || isReparseStat(info)) throw new error(`${label} is not a regular file: ${checked}`);
}
function atomicWriteBytes(value, data, { ensureParent = false, label = "write destination", error = ToolError } = {}) {
  const target = absolutePath(value, label, { error });
  if (ensureParent) ensureControlledDirectory(path2.dirname(target), { error });
  assertNoReparseComponents(path2.dirname(target), { allowMissing: false, error });
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw new error(`cannot inspect ${label} ${target}: ${caught.message}`);
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || isReparseStat(existing))) {
    throw new error(`${label} is not a regular file: ${target}`);
  }
  const temp = path2.join(path2.dirname(target), `.${path2.basename(target)}.tmp-${ids.uuidHex()}`);
  let fd = null;
  try {
    fd = openSync(temp, "wx", 384);
    const info = fstatSync(fd);
    if (!info.isFile()) throw new error(`temporary write is not a regular file: ${temp}`);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertNoReparseComponents(path2.dirname(target), { allowMissing: false, error });
    let current = null;
    try {
      current = lstatSync(target);
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw new error(`cannot recheck ${label} ${target}: ${caught.message}`);
    }
    if (current && (!current.isFile() || current.isSymbolicLink() || isReparseStat(current))) {
      throw new error(`${label} changed to a non-regular file: ${target}`);
    }
    renameSync(temp, target);
    assertRegularFile(target, "written file", { error });
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
    }
  }
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function homeDir() {
  return os.homedir();
}
var ToolError, frozen, clock, ids, ROOT, RUNTIME_ROOT, ROLE_NAME_RE, modelConfigCache;
var init_tool_common = __esm({
  "ops/tools/dispatch-core/_tool_common.mjs"() {
    init_dist();
    init_model_config();
    ToolError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "ToolError";
      }
    };
    frozen = null;
    clock = {
      now() {
        return frozen ? new Date(frozen.nowMs) : /* @__PURE__ */ new Date();
      }
    };
    ids = {
      uuidHex() {
        if (frozen) {
          const value = uuidFromSeed(frozen.uuidSeed, frozen.uuidIndex);
          frozen.uuidIndex += 1;
          return value;
        }
        return randomUUID().replace(/-/g, "");
      }
    };
    ROOT = projectRoot();
    RUNTIME_ROOT = runtimeRoot();
    ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
    modelConfigCache = null;
  }
});

// ops/tools/dispatch-core/_py.mjs
import { spawnSync } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
import path3 from "node:path";
import process4 from "node:process";
function pyStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "").replace(RE_RSTRIP, "");
}
function pyRStrip(value) {
  return String(value ?? "").replace(RE_RSTRIP, "");
}
function pyStripChars(value, chars) {
  const text3 = String(value ?? "");
  let start = 0;
  let end = text3.length;
  while (start < end && chars.includes(text3[start])) start += 1;
  while (end > start && chars.includes(text3[end - 1])) end -= 1;
  return text3.slice(start, end);
}
function pySplitLines(value) {
  const text3 = String(value ?? "");
  if (!text3) return [];
  const parts = text3.split(RE_LINE_BOUNDARY);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
function pyRepr(value) {
  if (value === null || value === void 0) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value)) return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  const text3 = String(value);
  const quote = text3.includes("'") && !text3.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text3) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (ch === " " || !NON_PRINTABLE_RE.test(ch)) out += ch;
    else if (code <= 255) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 65535) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}
function pyStr(value) {
  if (typeof value === "string") return value;
  if (value === null || value === void 0) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return pyRepr(value);
}
function pyTypeName(value) {
  if (value === null || value === void 0) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "dict";
}
function pyTruthy(value) {
  if (value === null || value === void 0 || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function pyOr(...values) {
  for (const value of values.slice(0, -1)) {
    if (pyTruthy(value)) return value;
  }
  return values[values.length - 1];
}
function pyFloat(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const text3 = pyStrip(value).replace(/(?<=[0-9])_(?=[0-9])/g, "");
    if (/^[+-]?(?:inf|infinity)$/i.test(text3)) return text3.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(text3)) return Number.NaN;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text3)) {
      throw pyError("ValueError", `could not convert string to float: ${pyRepr(value)}`);
    }
    return Number(text3);
  }
  throw pyError("TypeError", `float() argument must be a string or a real number, not '${pyTypeName(value)}'`);
}
function pyKeyError(message) {
  return pyError("KeyError", pyRepr(message));
}
function pyGetItem(container, key) {
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
function pyGet(container, key, fallback = void 0) {
  return isRecord(container) && Object.hasOwn(container, key) ? container[key] : fallback;
}
function pyJsonDumps(value, { compact = false } = {}) {
  const itemSep = compact ? "," : ", ";
  const keySep = compact ? ":" : ": ";
  const walk = (item) => {
    if (item === null || item === void 0) return "null";
    if (Array.isArray(item)) return `[${item.map(walk).join(itemSep)}]`;
    if (typeof item === "object") {
      return `{${Object.entries(item).filter(([, entry]) => entry !== void 0).map(([key, entry]) => `${JSON.stringify(String(key))}${keySep}${walk(entry)}`).join(itemSep)}}`;
    }
    return JSON.stringify(item);
  };
  return walk(value);
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
  for (; ; ) {
    let idx = end;
    while (idx < s.length) {
      const code = s.charCodeAt(idx);
      if (code === 34 || code === 92 || code <= 31) break;
      idx += 1;
    }
    if (idx >= s.length) throw jsonDecodeError("Unterminated string starting at", s, begin);
    out += s.slice(end, idx);
    const terminator = s[idx];
    end = idx + 1;
    if (terminator === '"') break;
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
      if (uni >= 55296 && uni <= 56319 && s.slice(end, end + 2) === "\\u") {
        const uni2 = decodeUXXXX(s, end + 1);
        if (uni2 >= 56320 && uni2 <= 57343) {
          uni = 65536 + (uni - 55296 << 10 | uni2 - 56320);
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
  for (; ; ) {
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
  for (; ; ) {
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
    const value = frac || exp ? Number.parseFloat(integer + (frac || "") + (exp || "")) : Number(integer) || 0;
    return [value, idx + whole.length];
  }
  if (nextchar === "N" && s.slice(idx, idx + 3) === "NaN") return [Number.NaN, idx + 3];
  if (nextchar === "I" && s.slice(idx, idx + 8) === "Infinity") return [Number.POSITIVE_INFINITY, idx + 8];
  if (nextchar === "-" && s.slice(idx, idx + 9) === "-Infinity") return [Number.NEGATIVE_INFINITY, idx + 9];
  throw new ScanStop(idx);
}
function pyJsonLoads(text3) {
  const s = String(text3);
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
function pyReadText(file) {
  const raw = readFileSync3(file);
  let text3;
  try {
    text3 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw pyError("UnicodeDecodeError", `'utf-8' codec can't decode file: ${String(file)}`);
  }
  return text3.replace(/\r\n?/g, "\n");
}
function pyReadTextReplace(file) {
  return readFileSync3(file, "utf8").replace(/\r\n?/g, "\n");
}
function pyNormcase(value) {
  const text3 = String(value);
  return process4.platform === "win32" ? text3.replace(/\//g, "\\").toLowerCase() : text3;
}
function pySamePath(left, right) {
  return pyNormcase(left) === pyNormcase(right);
}
function pathAnchor(root) {
  if (process4.platform !== "win32") return root;
  const anchor = root.replace(/\//g, "\\");
  return /^\\\\[^\\]+\\[^\\]+$/.test(anchor) ? `${anchor}\\` : anchor;
}
function pathParts(value) {
  const raw = String(value);
  const root = path3.parse(raw).root;
  const rest = raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  return { anchor: pathAnchor(root), parts: rest };
}
function pyPureStr(value) {
  const { anchor, parts } = pathParts(value);
  if (!parts.length) return anchor || ".";
  return anchor + parts.join(process4.platform === "win32" ? "\\" : "/");
}
function pyIsRelativeTo(child, parent) {
  const left = pathParts(child);
  const right = pathParts(parent);
  if (pyNormcase(left.anchor) !== pyNormcase(right.anchor)) return false;
  if (right.parts.length > left.parts.length) return false;
  return right.parts.every((part, index) => pyNormcase(part) === pyNormcase(left.parts[index]));
}
function pyRelativeToPosix(child, parent) {
  if (!pyIsRelativeTo(child, parent)) {
    throw pyError("ValueError", `${pyRepr(pyPureStr(child))} is not in the subpath of ${pyRepr(pyPureStr(parent))}`);
  }
  const tail2 = pathParts(child).parts.slice(pathParts(parent).parts.length);
  return tail2.length ? tail2.join("/") : ".";
}
function pyResolveUnder(value, base) {
  return resolveLikePython(pathlibJoin(base, value));
}
function pySpawnSync(command, args, options) {
  const cmd = String(command);
  if (process4.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    const quote = (value) => {
      const text3 = String(value);
      return /[\s"^&|<>()%!]/.test(text3) ? `"${text3.replace(/"/g, '\\"')}"` : text3;
    };
    const line = [cmd, ...args].map(quote).join(" ");
    return spawnSync(line, [], { ...options, shell: true });
  }
  return spawnSync(cmd, args, options);
}
var PY_SPACE_CLASS, PY_SPACE_RE, RE_LSTRIP, RE_RSTRIP, RE_LINE_BOUNDARY, NON_PRINTABLE_RE, JSON_WS, JSON_BACKSLASH, JSON_NUMBER_RE, ScanStop;
var init_py = __esm({
  "ops/tools/dispatch-core/_py.mjs"() {
    init_tool_common();
    PY_SPACE_CLASS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
    PY_SPACE_RE = new RegExp(`[${PY_SPACE_CLASS}]`);
    RE_LSTRIP = new RegExp(`^[${PY_SPACE_CLASS}]+`);
    RE_RSTRIP = new RegExp(`[${PY_SPACE_CLASS}]+$`);
    RE_LINE_BOUNDARY = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;
    NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
    JSON_WS = " 	\n\r";
    JSON_BACKSLASH = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "	" };
    JSON_NUMBER_RE = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
    ScanStop = class {
      constructor(idx) {
        this.idx = idx;
      }
    };
  }
});

// ops/node_modules/koffi/src/koffi/src/static.js
import { createRequire } from "node:module";
function loadStatic(pkg2) {
  let native2 = null;
  if (pkg2 == "linux-arm") {
    try {
      native2 = require2("@koromix/koffi-linux-arm");
    } catch (err) {
    }
  }
  if (pkg2 == "linux-arm64") {
    try {
      native2 = require2("@koromix/koffi-linux-arm64");
    } catch (err) {
    }
  }
  if (pkg2 == "linux-ia32") {
    try {
      native2 = require2("@koromix/koffi-linux-ia32");
    } catch (err) {
    }
  }
  if (pkg2 == "linux-x64") {
    try {
      native2 = require2("@koromix/koffi-linux-x64");
    } catch (err) {
    }
  }
  if (pkg2 == "linux-riscv64") {
    try {
      native2 = require2("@koromix/koffi-linux-riscv64");
    } catch (err) {
    }
  }
  if (pkg2 == "freebsd-ia32") {
    try {
      native2 = require2("@koromix/koffi-freebsd-ia32");
    } catch (err) {
    }
  }
  if (pkg2 == "freebsd-x64") {
    try {
      native2 = require2("@koromix/koffi-freebsd-x64");
    } catch (err) {
    }
  }
  if (pkg2 == "freebsd-arm64") {
    try {
      native2 = require2("@koromix/koffi-freebsd-arm64");
    } catch (err) {
    }
  }
  if (pkg2 == "openbsd-ia32") {
    try {
      native2 = require2("@koromix/koffi-openbsd-ia32");
    } catch (err) {
    }
  }
  if (pkg2 == "openbsd-x64") {
    try {
      native2 = require2("@koromix/koffi-openbsd-x64");
    } catch (err) {
    }
  }
  if (pkg2 == "win32-ia32") {
    try {
      native2 = require2("@koromix/koffi-win32-ia32");
    } catch (err) {
    }
  }
  if (pkg2 == "win32-x64") {
    try {
      native2 = require2("@koromix/koffi-win32-x64");
    } catch (err) {
    }
  }
  if (pkg2 == "win32-arm64") {
    try {
      native2 = require2("@koromix/koffi-win32-arm64");
    } catch (err) {
    }
  }
  if (pkg2 == "darwin-x64") {
    try {
      native2 = require2("@koromix/koffi-darwin-x64");
    } catch (err) {
    }
  }
  if (pkg2 == "darwin-arm64") {
    try {
      native2 = require2("@koromix/koffi-darwin-arm64");
    } catch (err) {
    }
  }
  if (pkg2 == "linux-loong64") {
    try {
      native2 = require2("@koromix/koffi-linux-loong64");
    } catch (err) {
    }
  }
  if (pkg2 == "android-arm64") {
    try {
      native2 = require2("@koromix/koffi-android-arm64");
    } catch (err) {
    }
  }
  if (pkg2 == "android-x64") {
    try {
      native2 = require2("@koromix/koffi-android-x64");
    } catch (err) {
    }
  }
  return native2;
}
var require2;
var init_static = __esm({
  "ops/node_modules/koffi/src/koffi/src/static.js"() {
    require2 = createRequire(import.meta.url);
  }
});

// ops/node_modules/koffi/src/koffi/index.js
import util from "node:util";
import fs2 from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import fs from "node:fs";
function determineAbi() {
  let abi = process.arch.toString();
  if (abi == "riscv32" || abi == "riscv64") {
    let file = openFile(process.execPath, "r");
    try {
      let header = readElfHeader(file);
      let float_abi = header.e_flags & 6;
      switch (float_abi) {
        case 0:
          {
          }
          break;
        case 2:
          {
            abi += "f";
          }
          break;
        case 4:
          {
            abi += "d";
          }
          break;
        case 6:
          {
            abi += "q";
          }
          break;
      }
    } finally {
      file.close();
    }
  } else if (abi == "arm") {
    let file = openFile(process.execPath, "r");
    try {
      let header = readElfHeader(file);
      if (header.e_flags & 1024) {
        abi += "hf";
      } else if (header.e_flags & 512) {
        abi += "sf";
      } else {
        throw new Error("Unknown ARM floating-point ABI");
      }
    } finally {
      file.close();
    }
  }
  return abi;
}
function readElfHeader(file, offset = 0) {
  let buf = file.read(offset, 512);
  if (buf.length < 16)
    throw new Error("Truncated header");
  if (buf[0] != 127 || buf[1] != 69 || buf[2] != 76 || buf[3] != 70)
    throw new Error("Invalid magic number");
  if (buf[6] != 1)
    throw new Error("Invalid ELF version");
  if (buf[5] != 1)
    throw new Error("Big-endian architectures are not supported");
  switch (buf[4]) {
    case 1:
      {
        if (buf.length < 68)
          throw new Error("Truncated ELF header");
        return {
          ei_class: 32,
          e_machine: buf.readUInt16LE(18),
          e_flags: buf.readUInt32LE(36),
          e_phoff: buf.readUInt32LE(28),
          e_phentsize: buf.readUInt16LE(42),
          e_phnum: buf.readUInt16LE(44)
        };
      }
      break;
    case 2:
      {
        if (buf.length < 120)
          throw new Error("Truncated ELF header");
        return {
          ei_class: 64,
          e_machine: buf.readUInt16LE(18),
          e_flags: buf.readUInt32LE(48),
          e_phoff: buf.readBigUInt64LE(32),
          e_phentsize: buf.readUInt16LE(54),
          e_phnum: buf.readUInt16LE(56)
        };
      }
      break;
    default:
      throw new Error("Invalid ELF class");
  }
}
function openFile(filename, flags) {
  let fd = fs.openSync(filename, flags);
  return new FileHandle(fd);
}
function detectPlatform() {
  if (process.versions.napi == null || process.versions.napi < package_default.cnoke.napi) {
    let major = parseInt(process.versions.node, 10);
    throw new Error(`This engine is based on Node ${process.versions.node}, but ${package_default.name} does not support the Node ${major}.x branch (Node-API < ${package_default.cnoke.napi})`);
  }
  let abi = determineAbi();
  let pkg2 = `${process.platform}-${process.arch}`;
  let triplets2 = [`${process.platform}_${abi}`];
  if (process.platform == "linux")
    triplets2.push(`musl_${abi}`);
  return [package_default.version, pkg2, triplets2];
}
function loadDynamic(dirname, pkg2, triplets2) {
  let suffix = "/../../build/koffi";
  let root = dirname + suffix;
  let roots = [root];
  let native2 = null;
  let err = null;
  if (process["resourcesPath"] != null) {
    let suffixes = [
      "/koffi",
      "/koffi/build",
      "/node_modules/koffi/build"
    ];
    for (let suffix2 of suffixes)
      roots.push(process["resourcesPath"] + suffix2);
  }
  let names = [
    `${import.meta.dirname}/../../../@koromix/koffi-${pkg2}`,
    ...triplets2.flatMap((triplet) => roots.map((dir) => `${dir}/${triplet}/koffi.node`))
  ];
  for (let name of names) {
    if (!fs2.existsSync(name))
      continue;
    try {
      native2 = require22(name);
      break;
    } catch (e) {
      err ??= e;
    }
  }
  if (native2 == null && err != null)
    throw err;
  return native2;
}
function wrapNative(native2, version2) {
  if (native2 == null)
    throw new Error("Cannot find the native Koffi module; did you bundle it correctly?");
  if (native2.version != version2)
    throw new Error("Mismatched native Koffi modules");
  let load = native2.load;
  let register = native2.register;
  let introspect = native2.type;
  native2.sizeof = (spec) => introspect(spec).size;
  native2.alignof = (spec) => introspect(spec).alignment;
  native2.offsetof = (spec, name) => {
    let info = introspect(spec);
    if (info.primitive != "Record")
      throw new TypeError("The offsetof() function can only be used with record types");
    let member = info.members[name];
    if (member == null)
      throw new Error(`Record type ${info.name} does not have member '${name}'`);
    return member.offset;
  };
  native2.register = (...args) => {
    if (args.length >= 3 && typeof args[1] == "function") {
      process.emitWarning("Using koffi.register() with a custom this value was deprecated in Koffi 2.17, use function.bind() instead", "DeprecationWarning", "KOFFI009");
      args[1] = args[1].bind(args[0]);
      args = args.slice(1);
    }
    return register(...args);
  };
  native2.load = (...args) => {
    let lib = load(...args);
    lib.cdecl = util.deprecate((...args2) => lib.func("__cdecl", ...args2), "The koffi.cdecl() function was deprecated in Koffi 2.7, use koffi.func(...) instead", "KOFFI003");
    lib.stdcall = util.deprecate((...args2) => lib.func("__stdcall", ...args2), 'The koffi.stdcall() function was deprecated in Koffi 2.7, use koffi.func("__stdcall", ...) instead', "KOFFI004");
    lib.fastcall = util.deprecate((...args2) => lib.func("__fastcall", ...args2), 'The koffi.fastcall() function was deprecated in Koffi 2.7, use koffi.func("__fastcall", ...) instead', "KOFFI005");
    lib.thiscall = util.deprecate((...args2) => lib.func("__thiscall", ...args2), 'The koffi.thiscall() function was deprecated in Koffi 2.7, use koffi.func("__thiscall", ...) instead', "KOFFI006");
    return lib;
  };
  native2.resolve = util.deprecate(native2.type, "The koffi.resolve() function was deprecated in Koffi 3.0, use koffi.type() instead", "KOFFI007");
  native2.introspect = util.deprecate(native2.type, "The koffi.introspect() function was deprecated in Koffi 3.0, use koffi.type() instead", "KOFFI008");
}
var FileHandle, package_default, require22, version, pkg, triplets, native, mod_LibraryHandle, mod_TypeObject, mod_Union, mod_address, mod_alias, mod_alignof, mod_alloc, mod_array, mod_as, mod_call, mod_config, mod_decode, mod_disposable, mod_encode, mod_enumeration, mod_errno, mod_extension, mod_free, mod_in, mod_inout, mod_introspect, mod_load, mod_node, mod_offsetof, mod_opaque, mod_os, mod_out, mod_pack, mod_pointer, mod_proto, mod_register, mod_reset, mod_resolve, mod_sizeof, mod_stats, mod_struct, mod_type, mod_types, mod_union, mod_unregister, mod_version, mod_view, index_default;
var init_koffi = __esm({
  "ops/node_modules/koffi/src/koffi/index.js"() {
    init_static();
    FileHandle = class {
      constructor(fd) {
        this.fd = fd;
      }
      close() {
        fs.closeSync(this.fd);
      }
      [Symbol.dispose]() {
        fs.closeSync(this.fd);
      }
      read(offset, len) {
        let buf = Buffer.allocUnsafe(len);
        let read = fs.readSync(this.fd, buf, 0, len, offset);
        return buf.subarray(0, read);
      }
    };
    package_default = { name: "koffi", version: "3.2.1", cnoke: { api: "../../vendor/node-api-headers", output: "../../bin/Koffi/{{ toolchain }}", node: 16, napi: 8 } };
    require22 = createRequire2(import.meta.url);
    [version, pkg, triplets] = detectPlatform();
    native = loadStatic(pkg) ?? loadDynamic(import.meta.dirname, pkg, triplets);
    wrapNative(native, version);
    mod_LibraryHandle = native.LibraryHandle;
    mod_TypeObject = native.TypeObject;
    mod_Union = native.Union;
    mod_address = native.address;
    mod_alias = native.alias;
    mod_alignof = native.alignof;
    mod_alloc = native.alloc;
    mod_array = native.array;
    mod_as = native.as;
    mod_call = native.call;
    mod_config = native.config;
    mod_decode = native.decode;
    mod_disposable = native.disposable;
    mod_encode = native.encode;
    mod_enumeration = native.enumeration;
    mod_errno = native.errno;
    mod_extension = native.extension;
    mod_free = native.free;
    mod_in = native.in;
    mod_inout = native.inout;
    mod_introspect = native.introspect;
    mod_load = native.load;
    mod_node = native.node;
    mod_offsetof = native.offsetof;
    mod_opaque = native.opaque;
    mod_os = native.os;
    mod_out = native.out;
    mod_pack = native.pack;
    mod_pointer = native.pointer;
    mod_proto = native.proto;
    mod_register = native.register;
    mod_reset = native.reset;
    mod_resolve = native.resolve;
    mod_sizeof = native.sizeof;
    mod_stats = native.stats;
    mod_struct = native.struct;
    mod_type = native.type;
    mod_types = native.types;
    mod_union = native.union;
    mod_unregister = native.unregister;
    mod_version = native.version;
    mod_view = native.view;
    index_default = native;
  }
});

// ops/node_modules/koffi/index.js
var init_koffi2 = __esm({
  "ops/node_modules/koffi/index.js"() {
    init_koffi();
    init_koffi();
  }
});

// ops/tools/dispatch-core/file_lock.mjs
import { closeSync as closeSync2, openSync as openSync2 } from "node:fs";
import { constants } from "node:os";
function osError(operation, code, target) {
  const error = new Error(`${operation} failed (${code}): ${target}`);
  error.code = code;
  return error;
}
function nativeBackend() {
  if (backend) return backend;
  if (process.platform === "win32") {
    const kernel = index_default.load("kernel32.dll");
    const create = kernel.func("intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, intptr_t)");
    const lock = kernel.func("int __stdcall LockFileEx(intptr_t, uint32_t, uint32_t, uint32_t, uint32_t, void *)");
    const close = kernel.func("int __stdcall CloseHandle(intptr_t)");
    const lastError = kernel.func("uint32_t __stdcall GetLastError()");
    backend = (target) => {
      const handle = create(target, 3221225472, 3, null, 4, 128, 0);
      if (handle === -1 || handle === -1n) throw osError("CreateFileW", lastError(), target);
      let held = false;
      try {
        const overlapped = Buffer.alloc(index_default.sizeof("uintptr_t") * 3 + 8);
        held = Boolean(lock(handle, 3, 0, 1, 0, overlapped));
        if (!held) {
          const code = lastError();
          if (code === 33) return null;
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
    const libc = index_default.load(null);
    const flock = libc.func("int flock(int, int)");
    backend = (target) => {
      const fd = openSync2(target, "a+");
      let held = false;
      try {
        let result;
        do {
          result = flock(fd, 2 | 4);
        } while (result !== 0 && index_default.errno() === constants.errno.EINTR);
        held = result === 0;
        if (!held) {
          const code = index_default.errno();
          if (code === constants.errno.EAGAIN || code === constants.errno.EWOULDBLOCK) return null;
          throw osError("flock", code, target);
        }
        return () => closeSync2(fd);
      } finally {
        if (!held) closeSync2(fd);
      }
    };
  }
  return backend;
}
function tryFileLock(target) {
  const release = nativeBackend()(target);
  if (release === null) return null;
  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      release();
    }
  });
}
var backend;
var init_file_lock = __esm({
  "ops/tools/dispatch-core/file_lock.mjs"() {
    init_koffi2();
  }
});

// ops/tools/async-core/runtime/shared.mjs
var HOST_REBOOT_MARGIN_MS;
var init_shared = __esm({
  "ops/tools/async-core/runtime/shared.mjs"() {
    HOST_REBOOT_MARGIN_MS = 5e3;
  }
});

// ops/tools/_dispatch-prepare-argv.mjs
var DISPATCH_PREPARE_SEED_FIELD_TYPES, DISPATCH_PREPARE_SEED_FIELDS, AUTHORIZATION_OVERRIDES, DISPATCH_PREPARE_OVERRIDE_FLAGS;
var init_dispatch_prepare_argv = __esm({
  "ops/tools/_dispatch-prepare-argv.mjs"() {
    DISPATCH_PREPARE_SEED_FIELD_TYPES = Object.freeze({
      route_id: "string",
      goal: "string",
      scope: "object",
      contract: "object",
      slug: "string",
      known_facts: "array",
      delegation_intent: "string",
      extensions: "object",
      read_scope_layers: "object",
      budget: "object",
      slice_id: "string",
      title: "string",
      version: "string",
      package_id: "string",
      agent: "object",
      project_positioning: "object",
      ownership: "object",
      concurrency_contract: "object",
      inputs: "object",
      expected_output: "object",
      runtime_context: "object",
      alignment: "object",
      planning_policy: "object",
      tool_contract: "object",
      stop_conditions: "array",
      handoff_contract: "object"
    });
    DISPATCH_PREPARE_SEED_FIELDS = Object.freeze(Object.keys(DISPATCH_PREPARE_SEED_FIELD_TYPES));
    AUTHORIZATION_OVERRIDES = Object.freeze(["effort_range", "outside_pool"]);
    DISPATCH_PREPARE_OVERRIDE_FLAGS = Object.freeze({
      pick: "--async-pick",
      model: "--async-model",
      authorization: "--async-authorization",
      effort: "--async-effort",
      target_cwd: "--async-target-cwd",
      execution_profile: "--async-execution-profile",
      origin_id: "--origin-id"
    });
  }
});

// ops/tools/dispatch-core/model_selection.mjs
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync4 } from "node:fs";
import path4 from "node:path";
function fail(code, file, field, message, where = {}) {
  const error = new ToolError(`${field ? `${file} ${field}` : file}\uFF1A${message}`);
  Object.assign(error, { code, file: String(file), field: field || null, ...where });
  throw error;
}
function text2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function asText(value) {
  return text2(value) ? value.trim() : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function readToml(file) {
  if (!text2(file) || !existsSync3(file)) fail("file_invalid", file || "(missing)", "", "\u6587\u4EF6\u4E0D\u5B58\u5728");
  try {
    return parse(readFileSync4(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    fail("file_invalid", file, "", `\u4E0D\u662F\u6709\u6548 TOML\uFF1A${error?.message ?? error}`);
  }
}
function optionalText(value, file, field, where) {
  if (value === void 0) return "";
  if (typeof value !== "string") fail("value_invalid", file, field, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32", where);
  return value.trim();
}
function loadNotes(file) {
  const data = readToml(file);
  const notes = /* @__PURE__ */ new Map();
  if (data.notes !== void 0 && !record(data.notes)) fail("value_invalid", file, "notes", '\u5FC5\u987B\u662F\u8868\uFF0C\u6BCF\u4E2A\u6A21\u578B\u5199\u4E00\u5F20 [notes."<\u6A21\u578B>"]');
  for (const [model, value] of Object.entries(data.notes ?? {})) {
    const at = `notes."${model}"`;
    if (!record(value)) fail("value_invalid", file, at, "\u5FC5\u987B\u662F\u8868");
    for (const key of Object.keys(value)) {
      if (REMOVED_NOTE_KEYS[key]) fail("field_removed", file, `${at}.${key}`, `\u5DF2\u5220\u9664\uFF0C${REMOVED_NOTE_KEYS[key]}`);
      if (!NOTE_KEYS.includes(key)) fail("field_unknown", file, `${at}.${key}`, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${NOTE_KEYS.join("\u3001")}`);
    }
    if (value.supports_vision !== void 0 && typeof value.supports_vision !== "boolean") {
      fail("value_invalid", file, `${at}.supports_vision`, "\u5FC5\u987B\u662F true \u6216 false");
    }
    const efforts = value.efforts ?? EFFORT_LEVELS;
    const ordered = Array.isArray(efforts) && efforts.length > 0 && efforts.every((item, index) => rank(item) >= 0 && (index === 0 || rank(item) > rank(efforts[index - 1])));
    if (!ordered) fail("value_invalid", file, `${at}.efforts`, `\u5FC5\u987B\u662F ${EFFORT_LEVELS.join(" < ")} \u7684\u975E\u7A7A\u5B50\u96C6\uFF0C\u6309\u6863\u4F4D\u987A\u5E8F\u6392\u5217\u4E14\u4E0D\u91CD\u590D`);
    notes.set(model, {
      tag: optionalText(value.tag, file, `${at}.tag`),
      supports_vision: value.supports_vision ?? null,
      description: optionalText(value.description, file, `${at}.description`),
      efforts: [...efforts],
      effort_note: optionalText(value.effort_note, file, `${at}.effort_note`)
    });
  }
  return notes;
}
function loadRoutes(root) {
  const dir = root ? path4.join(root, "ops", "protocols", "task-package-routes") : "";
  if (!dir || !existsSync3(dir)) return [];
  const routes = [];
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".md")).sort()) {
    const file = path4.join(dir, name);
    const body = readFileSync4(file, "utf8");
    const agent = AGENT_BLOCK_RE.exec(body);
    if (!agent) continue;
    const role = /(?:^|\n)\s*role:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    const capability = /capability:\s*\n(?:[^\n]*\n){0,4}?\s*name:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    if (!role || !capability) continue;
    let card = {};
    let phaseError = null;
    try {
      card = JSON.parse(CARD_RE.exec(body)?.[1] ?? "{}");
    } catch (error) {
      phaseError = `route_card \u4E0D\u662F\u6709\u6548 JSON\uFF1A${error?.message ?? error}`;
    }
    const phase = card.dispatch_phase;
    phaseError ??= phase === void 0 ? "\u5C1A\u672A\u5199\u5165 dispatch_phase" : !record(phase) || !["direct", "workflow"].includes(phase.kind) ? "dispatch_phase.kind \u5FC5\u987B\u662F direct \u6216 workflow" : phase.kind === "workflow" && !text2(phase.step) ? "dispatch_phase.step \u7F3A\u5C11\u771F\u5B9E\u6B65\u9AA4" : null;
    routes.push({
      role,
      capability,
      route_id: `${role}__${capability}`,
      description: asText(card.applies_to),
      dispatch_phase: phaseError ? null : { kind: phase.kind, step: text2(phase.step) ? phase.step.trim() : null },
      phase_error: phaseError,
      file
    });
  }
  return routes;
}
function nameList(value, file, field) {
  if (!Array.isArray(value) || value.some((item) => !text2(item))) fail("value_invalid", file, field, "\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\u6570\u7EC4");
  return [...new Set(value.map((item) => item.trim()))];
}
function projectSkillsValue(value, file, field) {
  if (PROJECT_SKILL_MODES.includes(value)) return value;
  if (Array.isArray(value)) return nameList(value, file, field);
  fail("value_invalid", file, field, '\u5FC5\u987B\u662F "none"\u3001"all" \u6216 skill \u540D\u5355');
}
function roleWorkerResources(data, file) {
  if (![...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => data[key] !== void 0)) return null;
  return {
    ...Object.fromEntries(WORKER_RESOURCE_LISTS.map((key) => [key, data[key] === void 0 ? [] : nameList(data[key], file, key)])),
    project_skills: data.project_skills === void 0 ? "none" : projectSkillsValue(data.project_skills, file, "project_skills")
  };
}
function capabilityWorkerResources(role, value, file, field) {
  const base = role ?? { tools: [], extensions: [], skills: [], project_skills: "none" };
  const out = { ...base };
  for (const key of WORKER_RESOURCE_LISTS) {
    if (value[key] === void 0) continue;
    const list = nameList(value[key], file, `${field}.${key}`);
    const extra = list.filter((name) => !base[key].includes(name));
    if (extra.length) fail("value_invalid", file, `${field}.${key}`, `\u53EA\u80FD\u6536\u7A84\u89D2\u8272\u6E05\u5355\uFF0C\u591A\u51FA ${extra.join(", ")}`);
    out[key] = list;
  }
  if (value.project_skills !== void 0) {
    const narrowed = projectSkillsValue(value.project_skills, file, `${field}.project_skills`);
    const allowed = base.project_skills === "all" || narrowed === "none" || Array.isArray(base.project_skills) && Array.isArray(narrowed) && narrowed.every((name) => base.project_skills.includes(name));
    if (!allowed) fail("value_invalid", file, `${field}.project_skills`, `\u53EA\u80FD\u6536\u7A84\u89D2\u8272\u7684 project_skills\uFF08\u89D2\u8272\u503C ${JSON.stringify(base.project_skills)}\uFF09`);
    out.project_skills = narrowed;
  }
  return role || [...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => value[key] !== void 0) ? out : null;
}
function effortsOf(notes, model) {
  return notes.get(model)?.efforts ?? EFFORT_LEVELS;
}
function loadPick(item, index, file, role, notes, known, ids2) {
  const field = `picks[${index}]`;
  const where = { role, pick_id: record(item) && text2(item.id) ? item.id.trim() : null };
  const bad = (code, key, message) => fail(code, file, key ? `${field}.${key}` : field, message, where);
  if (!record(item)) bad("value_invalid", "", "\u5FC5\u987B\u662F\u8868");
  if (item.slot !== void 0) bad("field_removed", "slot", "\u5DF2\u5220\u9664\uFF0C\u6539\u5199 model\uFF08Pi \u6A21\u578B\u5168\u540D\uFF09\u4E0E effort / effort_min / effort_max");
  const unknown = Object.keys(item).find((key) => !PICK_KEYS.includes(key));
  if (unknown) bad("field_unknown", unknown, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${PICK_KEYS.join("\u3001")}\u3002\u89D2\u8272\u9876\u5C42\u952E\u987B\u5199\u5728\u7B2C\u4E00\u4E2A [[picks]] \u4E4B\u524D`);
  const id = asText(item.id);
  if (!ID_RE.test(id)) bad("value_invalid", "id", `\u5FC5\u987B\u662F ASCII \u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u4E0E\u4E0B\u5212\u7EBF\uFF0C\u5B9E\u5F97 ${JSON.stringify(item.id)}`);
  if (ids2.has(id)) bad("pick_duplicate", "id", `${id} \u5728\u89D2\u8272\u5185\u91CD\u590D`);
  ids2.add(id);
  if (item.capability !== void 0 && !text2(item.capability)) bad("value_invalid", "capability", "\u4E0D\u80FD\u4E3A\u7A7A\uFF1B\u9002\u7528\u5168\u90E8\u4EFB\u52A1\u65F6\u5220\u9664\u8BE5\u5B57\u6BB5");
  const capability = item.capability === void 0 ? null : item.capability.trim();
  if (capability && !known.has(capability)) bad("capability_unknown", "capability", `${capability} \u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B`);
  if (!text2(item.model) || !item.model.includes("/")) bad("value_invalid", "model", "\u5FC5\u987B\u662F Pi \u6A21\u578B\u5168\u540D\uFF0C\u4F8B\u5982 openai-codex/gpt-6-sol");
  const model = item.model.trim();
  const levels = {};
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (rank(item[key]) < 0) bad("value_invalid", key, `\u5FC5\u987B\u662F ${EFFORT_LEVELS.join("/")} \u4E4B\u4E00\uFF0C\u5B9E\u5F97 ${JSON.stringify(item[key])}`);
    levels[key] = item[key];
  }
  if (rank(levels.effort_min) > rank(levels.effort_max)) bad("effort_order", "effort_min", `${levels.effort_min} \u9AD8\u4E8E effort_max ${levels.effort_max}`);
  if (rank(levels.effort) < rank(levels.effort_min) || rank(levels.effort) > rank(levels.effort_max)) {
    bad("effort_order", "effort", `${levels.effort} \u4E0D\u5728 effort_min\u2013effort_max\uFF08${levels.effort_min}\u2013${levels.effort_max}\uFF09\u5185`);
  }
  const allowed = effortsOf(notes, model);
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (!allowed.includes(levels[key])) {
      bad("effort_not_supported", key, `${levels[key]} \u4E0D\u5728 ${model} \u7684\u53EF\u9009\u6863\u4F4D\uFF08${allowed.join("/")}\uFF09\u5185\uFF1B\u6539\u9009\u6863\u4F4D\u6216\u5230\u6A21\u578B\u6863\u4F4D\u9875\u8C03\u6574`);
    }
  }
  if (item.default !== void 0 && typeof item.default !== "boolean") bad("value_invalid", "default", "\u5FC5\u987B\u662F true \u6216 false");
  return { id, when: optionalText(item.when, file, `${field}.when`, where), capability, model, ...levels, default: item.default === true };
}
function checkDefaults(picks, known, capabilities, file, role) {
  const seen = /* @__PURE__ */ new Map();
  picks.forEach((pick, index) => {
    if (!pick.default) return;
    const key = pick.capability ?? "";
    if (seen.has(key)) {
      fail("default_duplicate", file, `picks[${index}].default`, pick.capability ? `\u4EFB\u52A1\u7C7B\u578B ${pick.capability} \u7684\u9ED8\u8BA4\u884C\u53EA\u80FD\u6709\u4E00\u884C\uFF08\u5DF2\u6709 ${seen.get(key)}\uFF09` : `\u4E0D\u5E26 capability \u7684\u9ED8\u8BA4\u884C\u53EA\u80FD\u6709\u4E00\u884C\uFF08\u5DF2\u6709 ${seen.get(key)}\uFF09`, { role, pick_id: pick.id });
    }
    seen.set(key, pick.id);
  });
  const lacking = [...known].filter((capability) => !seen.has(capability));
  const sealed = lacking.find((capability) => capabilities.get(capability)?.inherit_role_picks === false);
  if (sealed) {
    fail("default_missing", file, `capabilities.${sealed}`, "\u4E0D\u7EE7\u627F\u89D2\u8272\u63A8\u8350\uFF0C\u5FC5\u987B\u6709\u4E00\u884C capability \u6307\u5411\u5B83\u7684 default \u63A8\u8350\u884C", { role });
  }
  if ((known.size === 0 || lacking.length) && !seen.has("")) {
    fail("default_missing", file, "picks", known.size === 0 ? "\u89D2\u8272\u6CA1\u6709\u4EFB\u52A1\u7C7B\u578B\uFF0C\u5FC5\u987B\u628A\u4E00\u884C\u4E0D\u5E26 capability \u7684\u63A8\u8350\u8BBE\u4E3A default" : `\u4EFB\u52A1\u7C7B\u578B ${lacking.join("\u3001")} \u6CA1\u6709\u4E13\u5C5E\u9ED8\u8BA4\uFF0C\u5FC5\u987B\u628A\u4E00\u884C\u4E0D\u5E26 capability \u7684\u63A8\u8350\u8BBE\u4E3A default`, { role });
  }
}
function loadRoleFile(file, routes, notes) {
  const data = readToml(file);
  const role = asText(data.name);
  if (!role) fail("value_invalid", file, "name", "\u89D2\u8272\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (`${role}.toml` !== path4.basename(file)) fail("value_invalid", file, "name", `\u4E0E\u6587\u4EF6\u540D\u4E0D\u4E00\u81F4\uFF1A${role}`);
  for (const [key, hint] of Object.entries(REMOVED_ROLE_KEYS)) {
    if (data[key] !== void 0) fail("field_removed", file, key, `\u5DF2\u5220\u9664\uFF0C${hint}`, { role });
  }
  const workerResources = roleWorkerResources(data, file);
  const roleRoutes = routes.filter((item) => item.role === role);
  const known = new Set(roleRoutes.map((item) => item.capability));
  const capabilities = /* @__PURE__ */ new Map();
  if (data.capabilities !== void 0 && !record(data.capabilities)) {
    fail("value_invalid", file, "capabilities", "\u5FC5\u987B\u662F\u8868\uFF0C\u6BCF\u4E2A\u4EFB\u52A1\u7C7B\u578B\u5199\u4E00\u5F20 [capabilities.<id>]", { role });
  }
  for (const [capability, value] of Object.entries(data.capabilities ?? {})) {
    const field = `capabilities.${capability}`;
    if (roleRoutes.length && !known.has(capability)) fail("capability_unknown", file, field, "\u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B", { role });
    if (!record(value)) fail("value_invalid", file, field, "\u5FC5\u987B\u662F\u8868", { role });
    if (value.inherit_role_picks !== void 0 && typeof value.inherit_role_picks !== "boolean") {
      fail("value_invalid", file, `${field}.inherit_role_picks`, "\u5FC5\u987B\u662F true \u6216 false", { role });
    }
    capabilities.set(capability, {
      inherit_role_picks: value.inherit_role_picks !== false,
      worker_resources: capabilityWorkerResources(workerResources, value, file, field)
    });
    known.add(capability);
  }
  if (!roleRoutes.length && Array.isArray(data.picks)) {
    for (const item of data.picks) if (record(item) && text2(item.capability)) known.add(item.capability.trim());
  }
  if (!Array.isArray(data.picks) || !data.picks.length) fail("value_invalid", file, "picks", "\u81F3\u5C11\u8981\u6709\u4E00\u884C\u63A8\u8350", { role });
  const ids2 = /* @__PURE__ */ new Set();
  const picks = data.picks.map((item, index) => loadPick(item, index, file, role, notes, known, ids2));
  checkDefaults(picks, known, capabilities, file, role);
  return {
    role,
    description: asText(data.description),
    file,
    picks,
    capabilities,
    routes: roleRoutes,
    known_capabilities: known,
    worker_resources: workerResources
  };
}
function roleNames(sources) {
  const names = /* @__PURE__ */ new Set();
  for (const dir of [sources.agents_dir, text2(sources.global_root) ? path4.join(sources.global_root, "ops", "agents") : ""]) {
    if (!text2(dir) || !existsSync3(dir)) continue;
    for (const name of readdirSync(dir)) if (ROLE_FILE_RE.test(name)) names.add(name.slice(0, -".toml".length));
  }
  return [...names].sort();
}
function loadSelectionConfig(sources) {
  if (!record(sources) || typeof sources.roleConfigPath !== "function") {
    throw new ToolError("loadSelectionConfig \u9700\u8981 resolveModelConfigSources \u7684\u8FD4\u56DE\u5BF9\u8C61");
  }
  const notes = loadNotes(sources.model_notes);
  const routes = loadRoutes(sources.global_root);
  const roles = /* @__PURE__ */ new Map();
  for (const name of roleNames(sources)) {
    const file = sources.roleConfigPath(name);
    if (existsSync3(file)) roles.set(name, loadRoleFile(file, routes, notes));
  }
  return {
    sources,
    config_source: sources.describe(),
    notes,
    routes,
    roles,
    warnings: routes.filter((route) => route.phase_error).map((route) => ({ code: "dispatch_phase_invalid", file: route.file, field: "dispatch_phase", role: route.role, message: route.phase_error }))
  };
}
function modelEfforts(config, model) {
  return [...effortsOf(config.notes, model)];
}
function roleRecord(config, role) {
  const found = config.roles.get(role);
  if (!found) throw new ToolError(`\u672A\u77E5\u89D2\u8272\uFF1A${role || "(\u7A7A)"}`);
  return found;
}
function requireCapability(role, capability) {
  if (!text2(capability)) throw new ToolError(`\u89E3\u6790 ${role.role} \u5FC5\u987B\u7ED9\u51FA\u4EFB\u52A1\u7C7B\u578B`);
  if (role.known_capabilities.size && !role.known_capabilities.has(capability)) {
    throw new ToolError(`${role.file}\uFF1A${capability} \u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B`);
  }
}
function inherits(role, capability) {
  return role.capabilities.get(capability)?.inherit_role_picks !== false;
}
function applicable(role, capability) {
  return role.picks.filter((item) => item.capability === capability || !item.capability && inherits(role, capability));
}
function effectiveDefault(role, capability) {
  return role.picks.find((item) => item.capability === capability && item.default) || (inherits(role, capability) ? role.picks.find((item) => !item.capability && item.default) : null) || null;
}
function selectionConfigFingerprint(config, { role = "" } = {}) {
  const roles = role ? [roleRecord(config, role)] : [...config.roles.values()];
  const snapshot = {
    notes: [...config.notes],
    roles: roles.map((item) => ({
      role: item.role,
      picks: item.picks,
      capabilities: [...item.capabilities],
      worker_resources: item.worker_resources
    }))
  };
  return `sha256:${createHash2("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}
function readAuthorization(value) {
  if (value == null || value === "") return null;
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new ToolError(`authorization \u4E0D\u662F\u6709\u6548 JSON\uFF1A${error?.message ?? error}`);
    }
  }
  if (!record(parsed)) throw new ToolError("authorization \u5FC5\u987B\u662F\u5BF9\u8C61 {quote, overrides}");
  if (!text2(parsed.quote)) throw new ToolError("authorization.quote \u5FC5\u987B\u662F\u7528\u6237\u672C\u8F6E\u539F\u8BDD");
  if (!Array.isArray(parsed.overrides) || parsed.overrides.some((item) => !AUTHORIZATION_OVERRIDES.includes(item))) {
    throw new ToolError(`authorization.overrides \u53EA\u80FD\u5305\u542B ${AUTHORIZATION_OVERRIDES.join("\u3001")}`);
  }
  return { quote: parsed.quote, overrides: [...parsed.overrides] };
}
function resolveSelection(config, input = {}) {
  const role = roleRecord(config, asText(input.role));
  const capability = asText(input.capability);
  requireCapability(role, capability);
  const requested = { pick: asText(input.pick) || null, model: asText(input.model) || null, effort: asText(input.effort) || null };
  if (requested.pick && requested.model) throw new ToolError("pick \u4E0E model \u53EA\u80FD\u586B\u4E00\u4E2A");
  if (requested.effort && rank(requested.effort) < 0) {
    throw new ToolError(`effort \u5FC5\u987B\u662F ${EFFORT_LEVELS.join("/")} \u4E4B\u4E00\uFF0C\u5B9E\u5F97 ${requested.effort}`);
  }
  const authorization = readAuthorization(input.authorization);
  let row;
  if (requested.model) {
    const fallback = effectiveDefault(role, capability);
    row = fallback?.model === requested.model ? fallback : applicable(role, capability).find((item) => item.model === requested.model) || null;
  } else if (requested.pick) {
    row = role.picks.find((item) => item.id === requested.pick);
    if (!row) throw new ToolError(`${role.file}\uFF1A\u63A8\u8350\u884C\u4E0D\u5B58\u5728\uFF1A${requested.pick}\uFF1B\u53EF\u9009 ${role.picks.map((item) => item.id).join("\u3001")}`);
    if (row.capability && row.capability !== capability) {
      throw new ToolError(`${role.file}\uFF1A\u63A8\u8350\u884C ${row.id} \u53EA\u7528\u4E8E\u4EFB\u52A1\u7C7B\u578B ${row.capability}\uFF0C\u4E0D\u80FD\u7528\u4E8E ${capability}`);
    }
  } else {
    row = effectiveDefault(role, capability);
    if (!row) throw new ToolError(`${role.file}\uFF1A\u4EFB\u52A1\u7C7B\u578B ${capability} \u6CA1\u6709\u6709\u6548\u9ED8\u8BA4\u63A8\u8350\u884C`);
  }
  const model = requested.model || row.model;
  const effort = requested.effort || row?.effort;
  if (!effort) throw new ToolError(`${model} \u4E0D\u5728 ${role.role} \u9002\u7528\u4E8E ${capability} \u7684\u63A8\u8350\u884C\u91CC\uFF0C\u5FC5\u987B\u663E\u5F0F\u7ED9\u51FA effort`);
  const efforts = modelEfforts(config, model);
  if (!efforts.includes(effort)) {
    throw new ToolError(`${effort} \u4E0D\u5728 ${model} \u7684\u53EF\u9009\u6863\u4F4D\uFF08${efforts.join("/")}\uFF09\u5185\uFF0C\u6388\u6743\u4E0D\u80FD\u89E3\u9664\uFF1B\u6539\u9009\u6863\u4F4D\u6216\u5230\u6A21\u578B\u6863\u4F4D\u9875\u8C03\u6574`);
  }
  const pool = [...new Set(role.picks.map((item) => item.model))];
  const needed = [];
  if (!pool.includes(model)) {
    needed.push({ kind: "outside_pool", previous_value: pool, message: `${model} \u4E0D\u5728 ${role.role} \u7684\u63A8\u8350\u884C\u91CC` });
  } else if (row && (rank(effort) < rank(row.effort_min) || rank(effort) > rank(row.effort_max))) {
    needed.push({
      kind: "effort_range",
      previous_value: [row.effort_min, row.effort_max],
      message: `${effort} \u8D85\u51FA\u63A8\u8350\u884C ${row.id} \u7684\u6863\u4F4D\u8303\u56F4 ${row.effort_min}\u2013${row.effort_max}`
    });
  }
  const missing = needed.filter((item) => !authorization?.overrides.includes(item.kind));
  if (missing.length) {
    throw new ToolError(missing.map((item) => `${item.message}\uFF0C\u9700\u8981\u7528\u6237\u6388\u6743\uFF1Aauthorization={quote: \u7528\u6237\u672C\u8F6E\u539F\u8BDD, overrides: ["${item.kind}"]}`).join("\uFF1B"));
  }
  return {
    requested,
    role: role.role,
    capability,
    pick: row?.id ?? null,
    config_source: {
      ...config.config_source,
      config_fingerprint: selectionConfigFingerprint(config, { role: role.role })
    },
    resolved_model: model,
    resolved_effort: effort,
    effort_source: requested.effort ? "explicit" : "pick",
    efforts,
    effort_range: row ? [row.effort_min, row.effort_max] : null,
    authorization: authorization ? {
      quote: authorization.quote,
      requested_overrides: authorization.overrides,
      applied_overrides: needed.map(({ kind, previous_value }) => ({ kind, previous_value }))
    } : null
  };
}
var EFFORT_LEVELS, ID_RE, ROLE_FILE_RE, PICK_KEYS, NOTE_KEYS, REMOVED_ROLE_KEYS, REMOVED_NOTE_KEYS, WORKER_RESOURCE_LISTS, PROJECT_SKILL_MODES, AGENT_BLOCK_RE, CARD_RE, rank;
var init_model_selection = __esm({
  "ops/tools/dispatch-core/model_selection.mjs"() {
    init_dist();
    init_dispatch_prepare_argv();
    init_tool_common();
    EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    ID_RE = /^[a-z0-9_]+$/;
    ROLE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/;
    PICK_KEYS = Object.freeze(["id", "when", "capability", "model", "effort", "effort_min", "effort_max", "default"]);
    NOTE_KEYS = Object.freeze(["tag", "supports_vision", "description", "efforts", "effort_note"]);
    REMOVED_ROLE_KEYS = Object.freeze({
      pi_model: "\u6539\u5199 [[picks]]",
      pi_model_reasoning_effort: "\u6539\u5199 [[picks]]",
      pi_candidates: "\u6539\u5199 [[picks]]",
      owner_note: "\u6539\u5199 [[picks]]",
      pi_effort_limits: "\u6863\u4F4D\u8303\u56F4\u6539\u5199\u5728\u5404\u63A8\u8350\u884C\u7684 effort_min / effort_max"
    });
    REMOVED_NOTE_KEYS = Object.freeze({
      max_effort: "\u53EF\u9009\u6863\u4F4D\u6539\u5199 efforts",
      effort_levels: "\u53EF\u9009\u6863\u4F4D\u6539\u5199 efforts\uFF0C\u5B9E\u6D4B\u8BF4\u660E\u5199 effort_note",
      status: "\u6A21\u578B\u662F\u5426\u53EF\u7528\u4EE5 Pi \u6A21\u578B\u6E05\u5355\u4E3A\u51C6"
    });
    WORKER_RESOURCE_LISTS = Object.freeze(["tools", "extensions", "skills"]);
    PROJECT_SKILL_MODES = Object.freeze(["none", "all"]);
    AGENT_BLOCK_RE = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
    CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;
    rank = (level) => EFFORT_LEVELS.indexOf(level);
  }
});

// ops/tools/dispatch-core/model_catalog_cache.mjs
import { mkdirSync as mkdirSync2, readFileSync as readFileSync5, renameSync as renameSync2, rmSync, statSync as statSync3, writeFileSync } from "node:fs";
import { createHash as createHash3, randomBytes } from "node:crypto";
import path5 from "node:path";
function canonicalJson2(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}
function catalogCacheKey(identity) {
  return createHash3("sha256").update(canonicalJson2(identity), "utf8").digest("hex");
}
function statOrNull(target) {
  try {
    return statSync3(target);
  } catch {
    return null;
  }
}
function fingerprintPaths(paths) {
  const seen = /* @__PURE__ */ new Set();
  const fingerprints = [];
  for (const raw of paths) {
    const target = String(raw ?? "");
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const stat = statOrNull(target);
    fingerprints.push({
      path: target,
      exists: Boolean(stat),
      size: stat ? stat.size : null,
      mtime_ms: stat ? Math.trunc(stat.mtimeMs) : null
    });
  }
  return fingerprints;
}
function readPayload(cacheFile) {
  let text3;
  try {
    text3 = readFileSync5(cacheFile, "utf8");
  } catch {
    return { entries: [] };
  }
  let payload;
  try {
    payload = JSON.parse(text3);
  } catch {
    return { entries: [] };
  }
  if (!payload || typeof payload !== "object" || payload.schema !== CATALOG_CACHE_SCHEMA) return { entries: [] };
  if (!Array.isArray(payload.entries)) return { entries: [] };
  return {
    entries: payload.entries.filter((entry) => entry && typeof entry === "object" && typeof entry.key === "string")
  };
}
function readCatalogCacheEntry(cacheFile, key, { now = Date.now() } = {}) {
  const entry = readPayload(cacheFile).entries.find((item) => item.key === key);
  if (!entry) return null;
  if (entry.status !== "ok") return null;
  const models = Array.isArray(entry.models) ? entry.models.filter((item) => typeof item === "string" && item) : [];
  if (!models.length) return null;
  const storedAt = Number(entry.stored_at_ms);
  if (!Number.isFinite(storedAt)) return null;
  const age = now - storedAt;
  if (age < 0 || age > CATALOG_CACHE_TTL_MS) return null;
  const details = entry.model_details && typeof entry.model_details === "object" && !Array.isArray(entry.model_details) ? entry.model_details : {};
  return {
    stored_at_ms: storedAt,
    identity: entry.identity ?? null,
    catalog: {
      status: "ok",
      models,
      model_details: details,
      model_count: models.length,
      source: typeof entry.source === "string" ? entry.source : "",
      error: null
    }
  };
}
function writeCatalogCacheEntry(cacheFile, key, identity, catalog, { now = Date.now() } = {}) {
  try {
    if (catalog?.status !== "ok") return false;
    const models = Array.isArray(catalog.models) ? catalog.models.filter((item) => typeof item === "string" && item) : [];
    if (!models.length) return false;
    const entry = {
      key,
      status: "ok",
      stored_at_ms: now,
      identity,
      models,
      model_details: catalog.model_details && typeof catalog.model_details === "object" && !Array.isArray(catalog.model_details) ? catalog.model_details : {},
      source: typeof catalog.source === "string" ? catalog.source : ""
    };
    const entries = [entry, ...readPayload(cacheFile).entries.filter((item) => item.key !== key)].slice(0, CATALOG_CACHE_MAX_ENTRIES);
    mkdirSync2(path5.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ schema: CATALOG_CACHE_SCHEMA, entries }, null, 2)}
`, "utf8");
      renameSync2(tmp, cacheFile);
    } finally {
      rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}
var CATALOG_CACHE_SCHEMA, CATALOG_CACHE_TTL_MS, CATALOG_CACHE_FILE_NAME, CATALOG_CACHE_MAX_ENTRIES;
var init_model_catalog_cache = __esm({
  "ops/tools/dispatch-core/model_catalog_cache.mjs"() {
    CATALOG_CACHE_SCHEMA = 1;
    CATALOG_CACHE_TTL_MS = 60 * 1e3;
    CATALOG_CACHE_FILE_NAME = "pi-child-model-catalog.json";
    CATALOG_CACHE_MAX_ENTRIES = 8;
  }
});

// ops/tools/dispatch-core/agent_panel_launcher.mjs
import { createHash as createHash4 } from "node:crypto";
import { closeSync as closeSync3, mkdirSync as mkdirSync3, openSync as openSync3, readdirSync as readdirSync2, readFileSync as readFileSync6, renameSync as renameSync3, rmSync as rmSync2, statSync as statSync4, writeFileSync as writeFileSync2, writeSync as writeSync2 } from "node:fs";
import net from "node:net";
import path6 from "node:path";
import { homedir } from "node:os";
import process5 from "node:process";
import { spawn as spawnChild, spawnSync as spawnSync2 } from "node:child_process";
function releasedPanelAssetRoot() {
  try {
    return JSON.parse(readFileSync6(path6.join(PANEL_STATE_ROOT, "runtime-root.json"), "utf8")).root;
  } catch {
    return void 0;
  }
}
function textOrEmpty(value) {
  if (typeof value === "string") return value;
  if (value === null || value === void 0 || value === false) return "";
  if (value === true) return "True";
  if (typeof value === "number") return value === 0 ? "" : String(value);
  return "";
}
function filled(value) {
  return isRecord(value) ? Object.keys(value).length > 0 : Boolean(value);
}
function isFile2(target) {
  try {
    return statSync4(target).isFile();
  } catch {
    return false;
  }
}
function errorText(error) {
  if (error === null || error === void 0) return "None";
  return typeof error?.message === "string" ? error.message : String(error);
}
function rstripSlash(value) {
  return String(value).replace(/\/+$/, "");
}
function resolveDeps(overrides = {}) {
  if (overrides && overrides.__resolved === true) return overrides;
  const deps4 = {
    __resolved: true,
    isProcessAlive,
    portIsFree,
    probeHealth,
    readJson,
    writeJson,
    spawnDetached,
    runCapture,
    now: utcNow2,
    currentPid: () => process5.pid,
    uuidHex: () => ids.uuidHex(),
    ...overrides,
    paths: { ...DEFAULT_PATHS, ...overrides.paths || {} }
  };
  deps4.isOurPanel ??= (payload, endpoint) => isOurPanel(payload, endpoint);
  deps4.allocateEndpoint ??= () => allocateEndpoint({ deps: deps4 });
  deps4.rememberProject ??= () => rememberProject({ deps: deps4 });
  deps4.validManifest ??= () => validManifest({ deps: deps4 });
  deps4.runningShell ??= () => runningShell({ deps: deps4 });
  deps4.buildRunning ??= () => buildRunning({ deps: deps4 });
  deps4.acquireBuildLock ??= () => acquireBuildLock({ deps: deps4 });
  deps4.startShell ??= (executable, endpoint) => startShell(executable, endpoint, { deps: deps4 });
  deps4.startBackgroundBuild ??= () => startBackgroundBuild({ deps: deps4 });
  return deps4;
}
function spawnDetached(argv, { cwd, env, windowsHide = true } = {}) {
  const child = spawnChild(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: "ignore",
    detached: true,
    windowsHide
  });
  child.unref();
  return { pid: child.pid };
}
function runCapture(argv, { cwd } = {}) {
  const proc = spawnSync2(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  const stdout = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  return { returncode: proc.error ? 1 : proc.status ?? 1, stdout: proc.error ? `${stdout}${proc.error.message}` : stdout };
}
function utcNow2() {
  return utcNow().replace("+00:00", "Z");
}
function readJson(file) {
  try {
    const value = JSON.parse(readFileSync6(file, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
function writeJson(file, value) {
  mkdirSync3(path6.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync2(temp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  renameSync3(temp, file);
  return null;
}
function normalizeIdentityPath(value) {
  const text3 = resolveLikePython(String(value)).replaceAll("\\", "/");
  return process5.platform === "win32" ? text3.toLowerCase() : text3;
}
function deriveEndpoint(panelRoot = PANEL_ROOT, controlRoot = MONITOR_ROOT) {
  const panelDigest = createHash4("sha256").update(normalizeIdentityPath(panelRoot), "utf8").digest();
  const port = PORT_BASE + panelDigest.readUInt16BE(0) % PORT_SPAN;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    panel_root: normalizeIdentityPath(panelRoot),
    control_root: normalizeIdentityPath(controlRoot)
  };
}
function rememberProject({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  const root = resolveLikePython(resolved.paths.controlRoot);
  const key = createHash4("sha256").update(normalizeIdentityPath(root)).digest("hex");
  resolved.writeJson(path6.join(resolved.paths.runtimeRoot, "projects", `${key}.json`), { project_root: root });
}
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port: Number(port), exclusive: true }, () => probe.close(() => resolve(true)));
  });
}
async function probeHealth(port, { timeout = 0.75 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/api/health`, {
      signal: AbortSignal.timeout(Math.round(timeout * 1e3))
    });
    if (!response.ok) return {};
    const payload = JSON.parse(await response.text());
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}
function isOurPanel(payload, endpoint) {
  return payload?.ok === true && payload.contract_version === "async-task-service/v1" && normalizeIdentityPath(textOrEmpty(payload.panel_root)) === pyGetItem(endpoint, "panel_root") && rstripSlash(textOrEmpty(payload.resolved_loopback_url)) === rstripSlash(pyGetItem(endpoint, "url"));
}
async function allocateEndpoint({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  const endpoint = deriveEndpoint(resolved.paths.panelRoot, resolved.paths.controlRoot);
  const health = await resolved.probeHealth(Number(endpoint.port));
  if (!await resolved.portIsFree(Number(endpoint.port)) && !resolved.isOurPanel(health, endpoint)) {
    throw pyError("RuntimeError", `Agent Panel \u56FA\u5B9A\u7AEF\u53E3 ${endpoint.port} \u5DF2\u88AB\u5176\u4ED6\u670D\u52A1\u5360\u7528\uFF1B\u505C\u6B62\u5360\u7528\u8005\u540E\u91CD\u8BD5`);
  }
  endpoint.updated_at = resolved.now();
  resolved.writeJson(resolved.paths.endpointPath, endpoint);
  return endpoint;
}
function isProcessAlive(pid) {
  let value;
  if (typeof pid === "number") {
    if (!Number.isFinite(pid)) return false;
    value = Math.trunc(pid);
  } else if (typeof pid === "string") {
    const text3 = pid.trim();
    if (!/^[+-]?\d+$/.test(text3)) return false;
    value = Number(text3);
  } else if (typeof pid === "boolean") {
    value = pid ? 1 : 0;
  } else {
    return false;
  }
  if (value <= 0) return false;
  try {
    process5.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function runningShell({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  const state = resolved.readJson(resolved.paths.shellStatePath);
  return state?.running === true && resolved.isProcessAlive(state.pid) ? state : {};
}
function buildRunning({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  const state = resolved.readJson(resolved.paths.buildStatePath);
  return state?.status === "running" && resolved.isProcessAlive(state.pid);
}
function runtimeBuildId({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  return resolved.readJson(path6.join(resolved.paths.assetRoot, "ops", "dist", "subagent_service.manifest.json")).build_id ?? null;
}
function validManifest({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  const manifest = resolved.readJson(resolved.paths.manifestPath);
  const executable = textOrEmpty(manifest?.executable);
  return executable && isFile2(executable) && manifest.runtime_build_id === runtimeBuildId({ deps: resolved }) ? manifest : {};
}
function launchOptions(resolved) {
  return {
    cwd: String(resolved.paths.panelRoot),
    env: {
      ...process5.env,
      SUBAGENT_PROJECT_ROOT: resolved.paths.controlRoot,
      SUBAGENT_CONTROL_REPO_ROOT: resolved.paths.controlRoot,
      SUBAGENT_RUNTIME_ROOT: resolved.paths.assetRoot,
      AGENT_PANEL_RUNTIME_ROOT: resolved.paths.assetRoot,
      AGENT_PANEL_STATE_ROOT: resolved.paths.runtimeRoot
    }
  };
}
function startShell(executable, endpoint, { deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  const child = resolved.spawnDetached(
    [
      String(executable),
      "--repository-root",
      String(resolved.paths.panelRoot),
      "--control-repo",
      String(resolved.paths.controlRoot),
      "--service-entry",
      "../../ops/dist/agent_panel_server.bundle.mjs",
      "--port",
      String(pyGetItem(endpoint, "port")),
      "--loopback-url",
      String(pyGetItem(endpoint, "url"))
    ],
    { ...launchOptions(resolved), windowsHide: false }
  );
  const state = {
    running: true,
    pid: child.pid,
    executable: String(executable),
    url: endpoint.url,
    started_at: resolved.now()
  };
  resolved.writeJson(resolved.paths.shellStatePath, state);
  return { status: "started", ...state };
}
function startBackgroundBuild({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  const child = resolved.spawnDetached(
    [process5.execPath, String(resolved.paths.buildScript), "--background-build"],
    launchOptions(resolved)
  );
  resolved.writeJson(resolved.paths.buildStatePath, {
    status: "running",
    pid: child.pid,
    started_at: resolved.now()
  });
  return child.pid;
}
async function ensureAgentPanel({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  try {
    if (!isFile2(resolved.paths.projectFile)) {
      throw pyError("RuntimeError", `Agent Panel shell project is missing: ${resolved.paths.projectFile}`);
    }
    resolved.rememberProject();
    const endpoint = await resolved.allocateEndpoint();
    const manifest = resolved.validManifest();
    const health = await resolved.probeHealth(Number(pyGetItem(endpoint, "port")));
    if (resolved.isOurPanel(health, endpoint)) return { status: "already_running", ...endpoint, monitor_root: health.control_repo_path };
    const shell = resolved.runningShell();
    if (filled(shell)) return { status: "starting", pid: shell.pid, ...endpoint };
    if (filled(manifest)) return resolved.startShell(String(pyGetItem(manifest, "executable")), endpoint);
    if (resolved.buildRunning()) return { status: "build_started", build_in_progress: true, ...endpoint };
    const pid = resolved.startBackgroundBuild();
    return { status: "build_started", pid, log_path: String(resolved.paths.buildLogPath), ...endpoint };
  } catch (error) {
    return { status: "failed", error: errorText(error), log_path: String(resolved.paths.buildLogPath) };
  }
}
function acquireBuildLock({ deps: deps4 } = {}) {
  const resolved = resolveDeps(deps4);
  mkdirSync3(resolved.paths.runtimeRoot, { recursive: true });
  try {
    return openSync3(resolved.paths.buildLockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    const stale = Date.now() / 1e3 - statSync4(resolved.paths.buildLockPath).mtimeMs / 1e3;
    if (stale > STILL_ACTIVE_LOCK_STALE_SECONDS && !resolved.buildRunning()) {
      rmSync2(resolved.paths.buildLockPath, { force: true });
      return openSync3(resolved.paths.buildLockPath, "wx");
    }
  } catch {
  }
  return null;
}
var MONITOR_ROOT, PANEL_STATE_ROOT, PANEL_ASSET_ROOT, PANEL_ROOT, SHELL_ROOT, PROJECT_FILE, RUNTIME_ROOT2, ENDPOINT_PATH, MANIFEST_PATH, BUILD_STATE_PATH, BUILD_LOG_PATH, BUILD_LOCK_PATH, SHELL_STATE_PATH, PORT_BASE, PORT_SPAN, DEFAULT_PATHS, STILL_ACTIVE_LOCK_STALE_SECONDS;
var init_agent_panel_launcher = __esm({
  "ops/tools/dispatch-core/agent_panel_launcher.mjs"() {
    init_tool_common();
    init_py();
    MONITOR_ROOT = path6.resolve(process5.env.SUBAGENT_PROJECT_ROOT || process5.cwd());
    PANEL_STATE_ROOT = path6.resolve(process5.env.AGENT_PANEL_STATE_ROOT || path6.join(homedir(), ".subagent-control", "agent-panel"));
    PANEL_ASSET_ROOT = path6.resolve(
      process5.env.AGENT_PANEL_RUNTIME_ROOT || releasedPanelAssetRoot() || path6.join(homedir(), ".pi", "agent", "extensions", "subagent-control")
    );
    PANEL_ROOT = path6.join(PANEL_ASSET_ROOT, "src", "agent-panel");
    SHELL_ROOT = path6.join(PANEL_ROOT, "shell");
    PROJECT_FILE = path6.join(SHELL_ROOT, "AgentPanel.Shell.csproj");
    RUNTIME_ROOT2 = PANEL_STATE_ROOT;
    ENDPOINT_PATH = path6.join(RUNTIME_ROOT2, "endpoint.json");
    MANIFEST_PATH = path6.join(RUNTIME_ROOT2, "build-manifest.json");
    BUILD_STATE_PATH = path6.join(RUNTIME_ROOT2, "build-state.json");
    BUILD_LOG_PATH = path6.join(RUNTIME_ROOT2, "last-build.log");
    BUILD_LOCK_PATH = path6.join(RUNTIME_ROOT2, "build.lock");
    SHELL_STATE_PATH = path6.join(RUNTIME_ROOT2, "shell-state.json");
    PORT_BASE = 43e3;
    PORT_SPAN = 1e3;
    DEFAULT_PATHS = Object.freeze({
      panelRoot: PANEL_ROOT,
      controlRoot: MONITOR_ROOT,
      assetRoot: PANEL_ASSET_ROOT,
      projectFile: PROJECT_FILE,
      runtimeRoot: RUNTIME_ROOT2,
      endpointPath: ENDPOINT_PATH,
      manifestPath: MANIFEST_PATH,
      buildStatePath: BUILD_STATE_PATH,
      buildLogPath: BUILD_LOG_PATH,
      buildLockPath: BUILD_LOCK_PATH,
      shellStatePath: SHELL_STATE_PATH,
      buildScript: path6.join(PANEL_ASSET_ROOT, "ops", "dist", "agent_panel_launcher.bundle.mjs")
    });
    STILL_ACTIVE_LOCK_STALE_SECONDS = 600;
  }
});

// ops/tools/dispatch-core/prepared_dispatch.mjs
import {
  closeSync as closeSync4,
  fstatSync as fstatSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync4,
  openSync as openSync4,
  readFileSync as readFileSync7,
  readdirSync as readdirSync3,
  rmSync as rmSync3,
  rmdirSync,
  statSync as statSync5,
  unlinkSync as unlinkSync2
} from "node:fs";
import path7 from "node:path";
function _relativeUnder(root, target) {
  const relative = path7.relative(root, target);
  if (!relative) return [];
  if (path7.isAbsolute(relative) || relative.split(/[\\/]/)[0] === "..") return null;
  return relative.split(/[\\/]+/).filter(Boolean);
}
function _parentsOf(target) {
  const parents = [];
  let current = path7.dirname(target);
  while (true) {
    parents.push(current);
    const next = path7.dirname(current);
    if (next === current) break;
    current = next;
  }
  return parents;
}
function _comparePaths(left, right) {
  const a = pyNormcase(left);
  const b = pyNormcase(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function _isNone(value) {
  return value === null || value === void 0;
}
function _isPlainObject(value) {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function _typeName(value) {
  if (value === void 0) return "undefined";
  const type = typeof value;
  if (type !== "object") return type;
  return value?.constructor?.name || "object";
}
function _validateOptionalString(value, label) {
  if (!_isNone(value) && typeof value !== "string") {
    throw new PreparedDispatchError(`${label} must be a string or null`);
  }
}
function _validateAsyncNestedObject(value, label, fields) {
  if (_isNone(value)) return null;
  if (!isRecord(value)) throw new PreparedDispatchError(`dispatch envelope.${label} must be an object or null`);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) {
    throw new PreparedDispatchError(
      `dispatch envelope.${label} has unknown fields: ${unknown.map(String).sort().join(", ")}`
    );
  }
  return value;
}
function _reviewEvidenceContract(pkg2) {
  if (!isRecord(pkg2)) return [false, null];
  let value = pkg2;
  const nested = value.task_package;
  if (isRecord(nested)) value = nested;
  const extensions = value.extensions;
  if (_isNone(extensions)) return [false, null];
  if (!isRecord(extensions)) throw new PreparedDispatchError("task package extensions must be an object");
  const executionPresent = Object.hasOwn(extensions, "review_execution");
  const evidencePresent = Object.hasOwn(extensions, "review_evidence");
  const reviewExecution = extensions.review_execution;
  const reviewEvidence = extensions.review_evidence;
  if (executionPresent && !isRecord(reviewExecution)) {
    throw new PreparedDispatchError("package review_execution must be an object");
  }
  if (evidencePresent && !isRecord(reviewEvidence)) {
    throw new PreparedDispatchError("package review_evidence must be an object");
  }
  const executionProfile = isRecord(reviewExecution) ? reviewExecution.profile : null;
  const evidenceProfile = isRecord(reviewEvidence) ? reviewEvidence.profile : null;
  for (const [present, profile, label] of [
    [executionPresent, executionProfile, "review_execution.profile"],
    [evidencePresent, evidenceProfile, "review_evidence.profile"]
  ]) {
    if (present && (typeof profile !== "string" || !profile.trim())) {
      throw new PreparedDispatchError(`package ${label} must be a non-empty string`);
    }
  }
  if (executionProfile && evidenceProfile && executionProfile !== evidenceProfile) {
    throw new PreparedDispatchError("package review execution/evidence profiles do not match");
  }
  const evidenceOnly = executionProfile === "evidence_only_v1" || evidenceProfile === "evidence_only_v1";
  if (evidenceOnly) {
    if (!isRecord(reviewExecution) || !isRecord(reviewEvidence)) {
      throw new PreparedDispatchError("evidence-only package requires execution and evidence metadata");
    }
    if (executionProfile !== "evidence_only_v1" || evidenceProfile !== "evidence_only_v1") {
      throw new PreparedDispatchError("evidence-only package profiles must both be evidence_only_v1");
    }
    if (reviewEvidence.complete !== true) {
      throw new PreparedDispatchError("evidence-only package requires complete review evidence");
    }
  }
  if (isRecord(reviewEvidence)) {
    const target = reviewEvidence.path;
    const complete = reviewEvidence.complete;
    if (typeof target !== "string" || !target.trim()) {
      throw new PreparedDispatchError("package review_evidence.path must be a non-empty string");
    }
    if (typeof complete !== "boolean") {
      throw new PreparedDispatchError("package review_evidence.complete must be a boolean");
    }
  }
  return [evidenceOnly, isRecord(reviewEvidence) ? reviewEvidence : null];
}
function validateAsyncDispatchV2(envelope, { package: pkg2 = null } = {}) {
  if (!isRecord(envelope)) throw new PreparedDispatchError("dispatch envelope must be an object");
  const unknown = Object.keys(envelope).filter((key) => !ASYNC_DISPATCH_V2_FIELDS.includes(key));
  if (unknown.length) {
    throw new PreparedDispatchError(
      `dispatch envelope has unknown fields: ${unknown.map(String).sort().join(", ")}`
    );
  }
  const missing = ASYNC_DISPATCH_REQUIRED_FIELDS.filter((key) => !Object.hasOwn(envelope, key));
  if (missing.length) {
    throw new PreparedDispatchError(
      `dispatch envelope is missing required fields: ${[...missing].sort().join(", ")}`
    );
  }
  for (const key of ["contract_version", "producer_root", "target_cwd", "task_file", "task_root"]) {
    const value = envelope[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new PreparedDispatchError(`dispatch envelope.${key} must be a non-empty string`);
    }
  }
  if (envelope.contract_version !== DISPATCH_CONTRACT_VERSION) {
    throw new PreparedDispatchError("dispatch envelope contract must be async-dispatch/v2");
  }
  if (typeof envelope.origin_thread_id !== "string") {
    throw new PreparedDispatchError("dispatch envelope.origin_thread_id must be a string");
  }
  for (const key of ["runner_path", "model", "effort", "result_mode", "display_title"]) {
    if (Object.hasOwn(envelope, key)) _validateOptionalString(envelope[key], `dispatch envelope.${key}`);
  }
  if (Object.hasOwn(envelope, "selection") && !_isNone(envelope.selection)) {
    if (!isRecord(envelope.selection)) throw new PreparedDispatchError("dispatch envelope.selection must be an object or null");
    const unknownSelection = Object.keys(envelope.selection).filter((key) => !SELECTION_FIELDS.includes(key));
    if (unknownSelection.length) {
      throw new PreparedDispatchError(`dispatch envelope.selection has unknown fields: ${unknownSelection.sort().join(", ")}`);
    }
    const missingSelection = SELECTION_FIELDS.filter((key) => !Object.hasOwn(envelope.selection, key));
    if (missingSelection.length) {
      throw new PreparedDispatchError(`dispatch envelope.selection is missing fields: ${missingSelection.sort().join(", ")}`);
    }
  }
  envelope = { ...envelope };
  if (Object.hasOwn(envelope, "runtime_role") && typeof envelope.runtime_role !== "string") {
    throw new PreparedDispatchError("dispatch envelope.runtime_role must be a string");
  }
  for (const key of ["batch_id", "slice_id"]) {
    if (Object.hasOwn(envelope, key)) _validateOptionalString(envelope[key], `dispatch envelope.${key}`);
  }
  if (!Object.hasOwn(envelope, "context_mode") || typeof envelope.context_mode !== "string" || !envelope.context_mode.trim()) {
    throw new PreparedDispatchError("dispatch envelope.context_mode must be a non-empty string");
  }
  if (!ASYNC_CONTEXT_MODES.includes(envelope.context_mode)) {
    throw new PreparedDispatchError("dispatch envelope.context_mode is not supported");
  }
  if (!Object.hasOwn(envelope, "execution_profile") || typeof envelope.execution_profile !== "string" || !envelope.execution_profile.trim()) {
    throw new PreparedDispatchError("dispatch envelope.execution_profile must be a non-empty string");
  }
  if (!ASYNC_EXECUTION_PROFILES.includes(envelope.execution_profile)) {
    throw new PreparedDispatchError("dispatch envelope.execution_profile is not supported");
  }
  if (Object.hasOwn(envelope, "result_mode") && !(_isNone(envelope.result_mode) || ASYNC_RESULT_MODES.includes(envelope.result_mode))) {
    throw new PreparedDispatchError("dispatch envelope.result_mode is not supported");
  }
  const simulation = _validateAsyncNestedObject(envelope.simulation, "simulation", SIMULATION_FIELDS);
  if (simulation !== null) {
    if (Object.hasOwn(simulation, "role") && typeof simulation.role !== "string") {
      throw new PreparedDispatchError("dispatch envelope.simulation.role must be a string");
    }
    if (Object.hasOwn(simulation, "persona") && !isRecord(simulation.persona)) {
      throw new PreparedDispatchError("dispatch envelope.simulation.persona must be an object");
    }
  }
  if (!Object.hasOwn(envelope, "budget") || !isRecord(envelope.budget)) {
    throw new PreparedDispatchError("dispatch envelope.budget must be an object");
  }
  if (Object.hasOwn(envelope, "save_raw_evidence") && typeof envelope.save_raw_evidence !== "boolean") {
    throw new PreparedDispatchError("dispatch envelope.save_raw_evidence must be a boolean");
  }
  if (Object.hasOwn(envelope, "turn_timeout_ms")) {
    const timeout = envelope.turn_timeout_ms;
    if (typeof timeout === "boolean" || !Number.isInteger(timeout) || timeout < 0) {
      throw new PreparedDispatchError("dispatch envelope.turn_timeout_ms must be a non-negative integer");
    }
  }
  if (Object.hasOwn(envelope, "stall_silence_ms") && !_isNone(envelope.stall_silence_ms)) {
    const silence = envelope.stall_silence_ms;
    if (typeof silence === "boolean" || !Number.isInteger(silence) || silence < 0) {
      throw new PreparedDispatchError(
        "dispatch envelope.stall_silence_ms must be a non-negative integer (0 disables stall detection)"
      );
    }
  }
  const producerRoot = absolutePath(envelope.producer_root, "dispatch producer_root", { error: PreparedDispatchError });
  const targetCwd = absolutePath(envelope.target_cwd, "dispatch target_cwd", { error: PreparedDispatchError });
  const taskRoot = absolutePath(envelope.task_root, "dispatch task_root", { error: PreparedDispatchError });
  if (!_isDirectory(targetCwd)) throw new PreparedDispatchError(`dispatch target_cwd does not exist: ${targetCwd}`);
  const runtimeRoot2 = path7.resolve(path7.join(producerRoot, ".runtime"));
  if (_relativeUnder(runtimeRoot2, taskRoot) === null) {
    throw new PreparedDispatchError("dispatch task_root must stay inside producer_root/.runtime");
  }
  const targetDomain = pyNormcase(resolveLikePython(targetCwd));
  const producerDomain = pyNormcase(resolveLikePython(producerRoot));
  const resultMode = envelope.result_mode || "";
  if (targetDomain !== producerDomain && !resultMode) {
    throw new PreparedDispatchError("cross-repo dispatch requires result_mode");
  }
  if (envelope.execution_profile === "simulation") {
    if (resultMode !== "simulated_planning" || !isRecord(simulation)) {
      throw new PreparedDispatchError(
        "simulation dispatch requires result_mode=simulated_planning and structured role/persona"
      );
    }
    const role = simulation.role;
    const persona = simulation.persona;
    if (typeof role !== "string" || !role.trim() || !isRecord(persona) || !Object.keys(persona).length) {
      throw new PreparedDispatchError(
        "simulation dispatch requires result_mode=simulated_planning and structured role/persona"
      );
    }
  }
  if (envelope.execution_profile !== "simulation" && resultMode === "simulated_planning") {
    throw new PreparedDispatchError("result_mode=simulated_planning requires execution_profile=simulation");
  }
  const [packageEvidenceOnly] = _reviewEvidenceContract(pkg2);
  const envelopeEvidenceOnly = envelope.execution_profile === "evidence_only_v1";
  if (packageEvidenceOnly && (!envelopeEvidenceOnly || envelope.context_mode !== "isolated")) {
    throw new PreparedDispatchError("evidence-only package requires evidence_only_v1/isolated dispatch");
  }
  if (envelopeEvidenceOnly && !packageEvidenceOnly) {
    throw new PreparedDispatchError("evidence_only_v1 dispatch requires an evidence-only package");
  }
  return { ...envelope };
}
function _isDirectory(target) {
  try {
    return statSync5(target).isDirectory();
  } catch {
    return false;
  }
}
function _canonicalJsonText(value, seen) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PreparedDispatchError(
        "value is not canonical JSON: Out of range float values are not JSON compliant"
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PreparedDispatchError("value is not canonical JSON: Circular reference detected");
    seen.add(value);
    const text3 = `[${value.map((item) => _canonicalJsonText(item, seen)).join(",")}]`;
    seen.delete(value);
    return text3;
  }
  if (_isPlainObject(value)) {
    if (seen.has(value)) throw new PreparedDispatchError("value is not canonical JSON: Circular reference detected");
    seen.add(value);
    const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const text3 = `{${keys.map((key) => `${JSON.stringify(key)}:${_canonicalJsonText(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return text3;
  }
  throw new PreparedDispatchError(
    `value is not canonical JSON: Object of type ${_typeName(value)} is not JSON serializable`
  );
}
function canonicalJsonBytes(value) {
  return Buffer.from(`${_canonicalJsonText(value, /* @__PURE__ */ new Set())}
`, "utf8");
}
function _assertNoEscape(target, root, { allowMissingLeaf = false } = {}) {
  const controlledRoot = absolutePath(root, "controlled root", { error: PreparedDispatchError });
  const candidate = absolutePath(target, "path", { error: PreparedDispatchError });
  const rootReal = resolveLikePython(controlledRoot);
  const pathReal = resolveLikePython(candidate);
  assertNoReparseComponents(controlledRoot, { allowMissing: allowMissingLeaf, error: PreparedDispatchError });
  assertNoReparseComponents(candidate, { allowMissing: allowMissingLeaf, error: PreparedDispatchError });
  if (_relativeUnder(rootReal, pathReal) === null) {
    throw new PreparedDispatchError(`path escapes controlled root: ${candidate}`);
  }
  let rootInfo = null;
  try {
    rootInfo = lstatSync2(controlledRoot);
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw new PreparedDispatchError(`cannot inspect controlled root: ${controlledRoot}`);
  }
  if (rootInfo && (rootInfo.isSymbolicLink() || isReparseStat(rootInfo))) {
    throw new PreparedDispatchError(`symlink/reparse controlled root: ${controlledRoot}`);
  }
  const parts = _relativeUnder(controlledRoot, candidate);
  if (parts === null) throw new PreparedDispatchError(`path is not under controlled root: ${candidate}`);
  let current = controlledRoot;
  for (const part of parts) {
    current = path7.join(current, part);
    let info;
    try {
      info = lstatSync2(current);
    } catch (caught) {
      if (caught?.code === "ENOENT") {
        if (allowMissingLeaf) break;
        throw new PreparedDispatchError(`path component does not exist: ${current}`);
      }
      throw new PreparedDispatchError(`cannot inspect path component ${current}: ${caught.message}`);
    }
    if (info.isSymbolicLink() || isReparseStat(info)) {
      throw new PreparedDispatchError(`symlink/reparse path is not permitted: ${current}`);
    }
  }
  return pathReal;
}
function _controlledParent(producerRoot) {
  const producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  ensureControlledDirectory(producer, { error: PreparedDispatchError });
  _assertNoEscape(producer, producer, { allowMissingLeaf: false });
  const parent = path7.join(producer, "tmp", "dispatch_prepare", PREPARATION_DIRECTORY_NAME);
  ensureControlledDirectory(parent, { error: PreparedDispatchError });
  _assertNoEscape(parent, producer, { allowMissingLeaf: false });
  return parent;
}
function _preparationHex() {
  const raw = ids.uuidHex().split("");
  raw[12] = "4";
  raw[16] = "89ab"[Number.parseInt(raw[16], 16) & 3];
  return raw.join("");
}
function allocatePreparationRoot(producerRoot, { retries = PREPARATION_ALLOCATION_RETRIES } = {}) {
  if (retries <= 0) throw new PreparedDispatchError("preparation allocation retries must be positive");
  const producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  const parent = _controlledParent(producer);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const preparation = path7.join(parent, `${PREPARATION_PREFIX}${_preparationHex()}`);
    try {
      mkdirSync4(preparation, { mode: 448 });
    } catch (caught) {
      if (caught?.code === "EEXIST") continue;
      throw caught;
    }
    _assertNoEscape(preparation, producer, { allowMissingLeaf: false });
    OWNED_UNCOMMITTED_ROOTS.add(pyNormcase(preparation));
    return preparation;
  }
  throw new PreparedDispatchError(`could not allocate an exclusive preparation root after ${retries} attempts`);
}
function _atomicWrite(target, data) {
  _writeAdapter.write(target, data);
}
function _packageId(pkg2) {
  const value = Object.hasOwn(pkg2, "task_package") ? pkg2.task_package : pkg2;
  if (!isRecord(value)) throw new PreparedDispatchError("task_package must be an object");
  const packageId2 = value.package_id;
  if (typeof packageId2 !== "string" || !packageId2 || packageId2 !== packageId2.trim()) {
    throw new PreparedDispatchError(
      "task_package.package_id must be a non-empty string without leading/trailing whitespace"
    );
  }
  return packageId2;
}
function _runtimeValue(options, key, defaultValue = null) {
  if (Object.hasOwn(options, key)) return options[key];
  const alias = Object.hasOwn(RUNTIME_VALUE_ALIASES, key) ? RUNTIME_VALUE_ALIASES[key] : "";
  return Object.hasOwn(options, alias) ? options[alias] : defaultValue;
}
function _makeEnvelope({ producerRoot, targetCwd, taskRoot, originId, options }) {
  const rawSelection = _runtimeValue(options, "model_selection", {});
  const modelSelection = isRecord(rawSelection) ? rawSelection : {};
  const text3 = (value) => value ? String(value) : "";
  return {
    contract_version: DISPATCH_CONTRACT_VERSION,
    producer_root: String(producerRoot),
    origin_thread_id: String(originId),
    target_cwd: String(targetCwd),
    task_file: "",
    task_root: String(taskRoot),
    runner_path: _runtimeValue(options, "runner_path") || null,
    runtime_role: text3(_runtimeValue(options, "runtime_role", "")),
    model: text3(_runtimeValue(options, "model", modelSelection.primary_model ?? "")) || null,
    effort: text3(_runtimeValue(options, "effort", modelSelection.primary_effort ?? "")) || null,
    ...isRecord(modelSelection.selection) ? { selection: modelSelection.selection } : {},
    context_mode: text3(_runtimeValue(options, "context_mode", "project-aware")) || "project-aware",
    execution_profile: text3(_runtimeValue(options, "execution_profile", "standard")) || "standard",
    result_mode: text3(_runtimeValue(options, "result_mode", "")) || null,
    simulation: (_runtimeValue(options, "simulation_profile") || _runtimeValue(options, "simulation")) ?? null,
    budget: _runtimeValue(options, "budget", {}),
    batch_id: _runtimeValue(options, "batch_id") || null,
    slice_id: _runtimeValue(options, "slice_id") || null,
    display_title: text3(_runtimeValue(options, "display_title", ""))
  };
}
function _invokeBuilder(builder, materialRoot, pkg2) {
  if (typeof builder !== "function") return builder(materialRoot, pkg2);
  return builder.length >= 2 ? builder(materialRoot, pkg2) : builder(materialRoot);
}
function _pathsWrittenByCallback(materialRoot, callbackResult) {
  const paths = [];
  if (isRecord(callbackResult)) {
    const raw = callbackResult.writes_performed;
    if (Array.isArray(raw)) {
      for (const value of raw) if (typeof value === "string") paths.push(value);
    }
  } else if (Array.isArray(callbackResult) || callbackResult instanceof Set) {
    for (const value of callbackResult) if (typeof value === "string") paths.push(value);
  }
  const normalized = [];
  for (const value of paths) {
    const candidate = absolutePath(
      path7.isAbsolute(value) ? value : path7.join(materialRoot, value),
      "callback output",
      { error: PreparedDispatchError }
    );
    _assertNoEscape(candidate, materialRoot, { allowMissingLeaf: false });
    const relative = path7.relative(materialRoot, candidate).replace(/\\/g, "/") || ".";
    if (RESERVED_FILENAMES.includes(relative)) {
      throw new PreparedDispatchError(`callback cannot claim reserved material file: ${relative}`);
    }
    if (!normalized.includes(relative)) normalized.push(relative);
  }
  return normalized;
}
function _iterWorkspaceFiles(materialRoot) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync3(directory);
    } catch (caught) {
      throw new PreparedDispatchError(`cannot inspect preparation output ${directory}: ${caught.message}`);
    }
    for (const name of entries) {
      const target = path7.join(directory, name);
      let info;
      try {
        info = lstatSync2(target);
      } catch (caught) {
        throw new PreparedDispatchError(`cannot inspect preparation output ${target}: ${caught.message}`);
      }
      if (info.isSymbolicLink() || isReparseStat(info)) {
        throw new PreparedDispatchError(`symlink/reparse preparation output: ${target}`);
      }
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) files.push(target);
      else throw new PreparedDispatchError(`unsupported preparation output type: ${target}`);
    }
  };
  assertNoReparseComponents(materialRoot, { allowMissing: false, error: PreparedDispatchError });
  visit(materialRoot);
  return files;
}
function _assertReservedFilesAbsent(materialRoot, { allowed = [] } = {}) {
  for (const filename of RESERVED_FILENAMES) {
    if (allowed.includes(filename)) continue;
    const target = path7.join(materialRoot, filename);
    try {
      lstatSync2(target);
    } catch (caught) {
      if (caught?.code === "ENOENT") continue;
      throw new PreparedDispatchError(`cannot inspect reserved material path ${target}: ${caught.message}`);
    }
    throw new PreparedDispatchError(`callback created reserved material path: ${filename}`);
  }
}
function _collectWorkspaceOutputs(materialRoot) {
  const outputs = [];
  for (const target of _iterWorkspaceFiles(materialRoot).sort(_comparePaths)) {
    if (RESERVED_FILENAMES.includes(path7.basename(target)) && pyNormcase(path7.dirname(target)) === pyNormcase(materialRoot)) {
      continue;
    }
    outputs.push(path7.relative(materialRoot, target).replace(/\\/g, "/"));
  }
  return outputs;
}
function _truthyMapping(candidate) {
  return isRecord(candidate) && Object.keys(candidate).length ? candidate : null;
}
function _firstMapping(...candidates) {
  for (const candidate of candidates) {
    const mapping = _truthyMapping(candidate);
    if (mapping !== null) return mapping;
  }
  return {};
}
function _pureRelative(root, value) {
  const parts = (text4) => String(text4).replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  const text3 = String(value);
  if (!path7.isAbsolute(text3)) return parts(text3).join("/") || ".";
  const target = parts(text3);
  const base = parts(root);
  if (!base.every((part, index) => pyNormcase(part) === pyNormcase(target[index] ?? ""))) return null;
  return target.slice(base.length).join("/") || ".";
}
function compilePreparedDispatch(pkg2, options = {}) {
  const {
    producerRoot,
    resolvedRuntimeOptions = null,
    runtimeOptions = null,
    runtime = null,
    dispatchEnvelope = null,
    envelope: envelopeOption = null,
    taskMaterial: taskMaterialOption = null,
    taskMaterialBuilder = null,
    reviewEvidenceBuilder = null,
    postMaterialCallback = null,
    originId = null,
    batchId = null,
    sliceId = null,
    displayTitle = ""
  } = options;
  let taskMaterial = taskMaterialOption;
  if (!isRecord(pkg2)) throw new PreparedDispatchError("package must be a dictionary");
  if (_isNone(originId) || typeof originId !== "string") {
    throw new PreparedDispatchError("origin_id must be explicitly supplied as a string");
  }
  const logicalPackageId = _packageId(pkg2);
  const producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  let runtimeOpts = { ..._firstMapping(resolvedRuntimeOptions, runtimeOptions, runtime) };
  if (!_isNone(options.targetCwd)) runtimeOpts.target_cwd = options.targetCwd;
  if (!_isNone(options.taskRoot)) runtimeOpts.task_root = options.taskRoot;
  let effectiveEnvelope = _truthyMapping(dispatchEnvelope) ?? _truthyMapping(envelopeOption) ?? null;
  let targetValue = _runtimeValue(runtimeOpts, "target_cwd");
  let taskRootValue = _runtimeValue(runtimeOpts, "task_root");
  if (_isNone(targetValue) && effectiveEnvelope !== null) targetValue = effectiveEnvelope.target_cwd ?? null;
  if (_isNone(taskRootValue) && effectiveEnvelope !== null) taskRootValue = effectiveEnvelope.task_root ?? null;
  if (!targetValue || !taskRootValue) {
    throw new PreparedDispatchError("target_cwd and task_root are required explicit runtime options");
  }
  let targetCwd = absolutePath(targetValue, "target_cwd", { error: PreparedDispatchError });
  let taskRoot = absolutePath(taskRootValue, "task_root", { error: PreparedDispatchError });
  if (!_isDirectory(targetCwd)) throw new PreparedDispatchError(`target_cwd does not exist: ${targetCwd}`);
  _assertTaskRootInsideRuntime(taskRoot, producer);
  const effectiveOriginId = originId;
  let effectiveBatchId = !_isNone(batchId) ? batchId : effectiveEnvelope !== null ? effectiveEnvelope.batch_id ?? null : null;
  let effectiveSliceId = !_isNone(sliceId) ? sliceId : effectiveEnvelope !== null ? effectiveEnvelope.slice_id ?? null : null;
  let effectiveDisplayTitle = displayTitle ? displayTitle : String((effectiveEnvelope !== null ? effectiveEnvelope.display_title : null) || "");
  if (!_isNone(effectiveBatchId) && typeof effectiveBatchId !== "string") {
    throw new PreparedDispatchError("batch_id must be a string or null");
  }
  if (!_isNone(effectiveSliceId) && typeof effectiveSliceId !== "string") {
    throw new PreparedDispatchError("slice_id must be a string or null");
  }
  const materialRoot = allocatePreparationRoot(producer);
  let committed = false;
  let descriptorWriteStarted = false;
  try {
    _assertReservedFilesAbsent(materialRoot);
    let callbackResult = null;
    if (!_isNone(reviewEvidenceBuilder)) {
      callbackResult = _invokeBuilder(reviewEvidenceBuilder, materialRoot, pkg2);
    }
    _assertReservedFilesAbsent(materialRoot);
    if (!_isNone(postMaterialCallback)) {
      const postResult = _invokeBuilder(postMaterialCallback, materialRoot, pkg2);
      if (isRecord(postResult)) {
        let finalOptions = postResult.runtime_options;
        if (_isNone(finalOptions)) finalOptions = postResult.resolved_runtime_options;
        if (isRecord(finalOptions)) runtimeOpts = { ...finalOptions };
        let finalEnvelope = postResult.envelope;
        if (_isNone(finalEnvelope)) finalEnvelope = postResult.dispatch_envelope;
        if (isRecord(finalEnvelope)) effectiveEnvelope = structuredClone({ ...finalEnvelope });
      }
    }
    _assertReservedFilesAbsent(materialRoot);
    if (_isNone(batchId) && effectiveEnvelope !== null) effectiveBatchId = effectiveEnvelope.batch_id ?? null;
    if (_isNone(sliceId) && effectiveEnvelope !== null) effectiveSliceId = effectiveEnvelope.slice_id ?? null;
    if (!displayTitle && effectiveEnvelope !== null) {
      effectiveDisplayTitle = String(effectiveEnvelope.display_title || "");
    }
    let finalTargetValue = _runtimeValue(runtimeOpts, "target_cwd");
    let finalTaskRootValue = _runtimeValue(runtimeOpts, "task_root");
    if (_isNone(finalTargetValue) && effectiveEnvelope !== null) {
      finalTargetValue = effectiveEnvelope.target_cwd ?? null;
    }
    if (_isNone(finalTaskRootValue) && effectiveEnvelope !== null) {
      finalTaskRootValue = effectiveEnvelope.task_root ?? null;
    }
    if (!finalTargetValue || !finalTaskRootValue) {
      throw new PreparedDispatchError("post-material callback did not provide target_cwd and task_root");
    }
    targetCwd = absolutePath(finalTargetValue, "target_cwd", { error: PreparedDispatchError });
    taskRoot = absolutePath(finalTaskRootValue, "task_root", { error: PreparedDispatchError });
    if (!_isDirectory(targetCwd)) throw new PreparedDispatchError(`target_cwd does not exist: ${targetCwd}`);
    _assertTaskRootInsideRuntime(taskRoot, producer);
    const finalPackageId = _packageId(pkg2);
    if (finalPackageId !== logicalPackageId) {
      throw new PreparedDispatchError("task_package.package_id changed during preparation");
    }
    const packageFile = path7.join(materialRoot, PACKAGE_FILENAME);
    const taskFile = path7.join(materialRoot, TASK_FILENAME);
    const dispatchFile = path7.join(materialRoot, DISPATCH_FILENAME);
    const descriptorFile = path7.join(materialRoot, DESCRIPTOR_FILENAME);
    const packageBytes = canonicalJsonBytes(pkg2);
    const frozenPackage = JSON.parse(packageBytes.toString("utf8"));
    _reviewEvidenceContract(frozenPackage);
    _atomicWrite(packageFile, packageBytes);
    if (!_isNone(taskMaterialBuilder)) {
      const builtTask = _invokeBuilder(taskMaterialBuilder, packageFile, structuredClone(frozenPackage));
      if (typeof builtTask !== "string" && !Buffer.isBuffer(builtTask)) {
        throw new PreparedDispatchError("task material builder must return str or bytes");
      }
      taskMaterial = builtTask;
    }
    if (!canonicalJsonBytes(pkg2).equals(packageBytes)) {
      throw new PreparedDispatchError("task material builder mutated the prepared package");
    }
    if (!_readFile(packageFile, "package").equals(packageBytes)) {
      throw new PreparedDispatchError("task material builder changed the persisted package");
    }
    _assertReservedFilesAbsent(materialRoot, { allowed: [PACKAGE_FILENAME] });
    if (_isNone(taskMaterial)) {
      const packageText = packageBytes.toString("utf8");
      taskMaterial = `# Prepared task material

\`\`\`json
${packageText}\`\`\`
`;
    }
    if (typeof taskMaterial !== "string" && !Buffer.isBuffer(taskMaterial)) {
      throw new PreparedDispatchError("task material builder must return str or bytes");
    }
    const taskBytes = Buffer.isBuffer(taskMaterial) ? taskMaterial : Buffer.from(taskMaterial, "utf8");
    _atomicWrite(taskFile, taskBytes);
    let envelope;
    if (effectiveEnvelope === null) {
      envelope = _makeEnvelope({
        producerRoot: producer,
        targetCwd,
        taskRoot,
        originId: effectiveOriginId,
        options: runtimeOpts
      });
    } else {
      envelope = structuredClone({ ...effectiveEnvelope });
      envelope.contract_version = String(envelope.contract_version || DISPATCH_CONTRACT_VERSION);
      envelope.producer_root = String(producer);
      envelope.target_cwd = String(targetCwd);
      envelope.task_root = String(taskRoot);
      envelope.origin_thread_id = effectiveOriginId;
    }
    for (const [key, value] of [
      ["runner_path", null],
      ["runtime_role", ""],
      ["model", null],
      ["effort", null],
      ["context_mode", "project-aware"],
      ["execution_profile", "standard"],
      ["result_mode", null],
      ["simulation", null],
      ["budget", {}],
      ["batch_id", null],
      ["slice_id", null],
      ["display_title", ""]
    ]) {
      if (!Object.hasOwn(envelope, key)) envelope[key] = value;
    }
    envelope.task_file = String(taskFile);
    if (!_isNone(effectiveBatchId)) envelope.batch_id = effectiveBatchId || null;
    if (!_isNone(effectiveSliceId)) envelope.slice_id = effectiveSliceId || null;
    if (effectiveDisplayTitle) envelope.display_title = effectiveDisplayTitle;
    if (envelope.contract_version !== DISPATCH_CONTRACT_VERSION) {
      throw new PreparedDispatchError("prepared dispatch must use async-dispatch/v2");
    }
    envelope = validateAsyncDispatchV2(envelope, { package: frozenPackage });
    const dispatchBytes = canonicalJsonBytes(envelope);
    _atomicWrite(dispatchFile, dispatchBytes);
    const descriptor = {
      contract_version: DESCRIPTOR_CONTRACT_VERSION,
      state: "prepared",
      preparation_id: path7.basename(materialRoot),
      dispatch_contract_version: DISPATCH_CONTRACT_VERSION,
      producer_root: String(producer),
      material_root: String(materialRoot),
      package_id: logicalPackageId,
      package_file: String(packageFile),
      task_file: String(taskFile),
      dispatch_file: String(dispatchFile),
      descriptor_file: String(descriptorFile),
      target_cwd: String(targetCwd),
      task_root: String(taskRoot),
      origin_id: effectiveOriginId,
      batch_id: effectiveBatchId || null,
      slice_id: effectiveSliceId || null,
      writes_performed: []
    };
    const selection = isRecord(runtimeOpts.model_selection) ? runtimeOpts.model_selection : null;
    if (selection !== null) {
      descriptor.model_selection = {
        model: envelope.model ?? null,
        effort: envelope.effort ?? null,
        model_source: String(selection.model_source || ""),
        effort_source: String(selection.effort_source || ""),
        child_model: structuredClone(selection.child_model || {})
      };
    }
    const callbackPaths = _pathsWrittenByCallback(materialRoot, callbackResult);
    for (const target of _collectWorkspaceOutputs(materialRoot)) {
      if (!callbackPaths.includes(target)) callbackPaths.push(target);
    }
    descriptor.writes_performed = callbackPaths;
    _validatePackageEvidencePath(frozenPackage, {
      producerRoot: producer,
      materialRoot,
      preparedOutputs: callbackPaths
    });
    descriptorWriteStarted = true;
    _atomicWrite(descriptorFile, canonicalJsonBytes(descriptor));
    committed = true;
    OWNED_UNCOMMITTED_ROOTS.delete(pyNormcase(materialRoot));
    return descriptor;
  } catch (caught) {
    if (!committed) {
      try {
        if (!descriptorWriteStarted) _discardUntrustedDescriptorMarker(materialRoot);
        cleanupUncommittedPreparation(materialRoot, { producerRoot: producer });
      } catch {
      }
    }
    throw caught;
  }
}
function _assertTaskRootInsideRuntime(taskRoot, producer) {
  const runtimeRoot2 = path7.join(producer, ".runtime");
  try {
    if (_relativeUnder(resolveLikePython(runtimeRoot2), taskRoot) === null) {
      throw new PreparedDispatchError("task_root is not relative to producer_root/.runtime");
    }
    _assertNoEscape(taskRoot, runtimeRoot2, { allowMissingLeaf: true });
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) {
      throw new PreparedDispatchError("task_root must stay inside producer_root/.runtime");
    }
    throw caught;
  }
}
function _readFile(target, label) {
  const file = absolutePath(target, label, { error: PreparedDispatchError });
  assertRegularFile(file, label, { error: PreparedDispatchError });
  let fd = null;
  try {
    fd = openSync4(file, "r");
    const info = fstatSync2(fd);
    if (!info.isFile()) throw new PreparedDispatchError(`${label} is not a regular file: ${file}`);
    return readFileSync7(fd);
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) throw caught;
    throw new PreparedDispatchError(`cannot read ${label}: ${file}`);
  } finally {
    if (fd !== null) {
      try {
        closeSync4(fd);
      } catch {
      }
    }
  }
}
function _descriptorPath(value, label) {
  let target;
  if (typeof value === "string" && value.trim()) target = value;
  else throw new PreparedDispatchError(`descriptor.${label} must be a non-empty absolute path`);
  if (!path7.isAbsolute(target)) {
    throw new PreparedDispatchError(`descriptor.${label} must be a non-empty absolute path`);
  }
  return absolutePath(target, `descriptor.${label}`, { error: PreparedDispatchError });
}
function _pathEqual(left, right) {
  return pyNormcase(absolutePath(left, "path", { error: PreparedDispatchError })) === pyNormcase(absolutePath(right, "path", { error: PreparedDispatchError }));
}
function _validatePackageEvidencePath(pkg2, { producerRoot, materialRoot, preparedOutputs }) {
  const [, evidenceRef] = _reviewEvidenceContract(pkg2);
  if (evidenceRef === null) return;
  let evidencePath = String(evidenceRef.path);
  if (!path7.isAbsolute(evidencePath)) evidencePath = path7.join(producerRoot, evidencePath);
  evidencePath = absolutePath(evidencePath, "review evidence", { error: PreparedDispatchError });
  _assertNoEscape(evidencePath, materialRoot, { allowMissingLeaf: false });
  const evidenceRelative = path7.relative(materialRoot, evidencePath).replace(/\\/g, "/");
  if (!preparedOutputs.includes(evidenceRelative)) {
    throw new PreparedDispatchError("package review_evidence is absent from prepared outputs");
  }
  const evidenceBytes = _readFile(evidencePath, "review evidence");
  let evidence;
  try {
    evidence = JSON.parse(evidenceBytes.toString("utf8"));
  } catch {
    throw new PreparedDispatchError(`review evidence is not valid UTF-8 JSON: ${evidencePath}`);
  }
  if (!isRecord(evidence)) throw new PreparedDispatchError("review evidence root must be a JSON object");
}
function _uuid4Hex(hexPart) {
  const cleaned = String(hexPart).replace(/urn:/g, "").replace(/uuid:/g, "").replace(/^[{]+|[}]+$/g, "").replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(cleaned)) return false;
  const value = BigInt(`0x${cleaned}`);
  if (!(value & 0x8000n << 48n)) return false;
  if (value & 0x4000n << 48n) return false;
  return Number(value >> 76n & 0xfn) === 4;
}
function _validateDescriptorShape(descriptor) {
  if (!isRecord(descriptor)) throw new PreparedDispatchError("descriptor root must be an object");
  const requiredStrings = [
    "contract_version",
    "state",
    "preparation_id",
    "dispatch_contract_version",
    "producer_root",
    "material_root",
    "package_id",
    "package_file",
    "task_file",
    "dispatch_file",
    "descriptor_file",
    "target_cwd",
    "task_root",
    "origin_id"
  ];
  const missing = requiredStrings.filter((key) => !Object.hasOwn(descriptor, key));
  if (missing.length) {
    throw new PreparedDispatchError(`descriptor is missing required fields: ${missing.join(", ")}`);
  }
  for (const key of requiredStrings) {
    if (typeof descriptor[key] !== "string") throw new PreparedDispatchError(`descriptor.${key} must be a string`);
  }
  if (!descriptor.contract_version.trim() || !descriptor.state.trim()) {
    throw new PreparedDispatchError("descriptor contract_version and state must be non-empty");
  }
  if (!descriptor.package_id || descriptor.package_id !== descriptor.package_id.trim()) {
    throw new PreparedDispatchError(
      "descriptor.package_id must be a non-empty string without leading/trailing whitespace"
    );
  }
  const preparationId = descriptor.preparation_id;
  if (!preparationId.startsWith(PREPARATION_PREFIX)) {
    throw new PreparedDispatchError("descriptor.preparation_id has invalid prefix");
  }
  const hexPart = preparationId.slice(PREPARATION_PREFIX.length);
  if (hexPart.length !== 32 || !_uuid4Hex(hexPart)) {
    throw new PreparedDispatchError("descriptor.preparation_id must be prep-<uuid4hex>");
  }
  for (const key of ["batch_id", "slice_id"]) {
    if (!Object.hasOwn(descriptor, key)) throw new PreparedDispatchError(`descriptor.${key} is required`);
    if (!_isNone(descriptor[key]) && typeof descriptor[key] !== "string") {
      throw new PreparedDispatchError(`descriptor.${key} must be a string or null`);
    }
  }
  const selection = descriptor.model_selection;
  if (!_isNone(selection)) {
    if (!isRecord(selection) || Object.keys(selection).sort().join("\0") !== [...DESCRIPTOR_MODEL_SELECTION_FIELDS].sort().join("\0")) {
      throw new PreparedDispatchError("descriptor.model_selection has an invalid schema");
    }
    for (const key of ["model", "effort"]) {
      if (!_isNone(selection[key]) && typeof selection[key] !== "string") {
        throw new PreparedDispatchError(`descriptor.model_selection.${key} must be a string or null`);
      }
    }
    for (const key of ["model_source", "effort_source"]) {
      if (typeof selection[key] !== "string" || !selection[key].trim()) {
        throw new PreparedDispatchError(`descriptor.model_selection.${key} must be a non-empty string`);
      }
    }
    const childModel = selection.child_model;
    if (!isRecord(childModel) || !DESCRIPTOR_CHILD_MODEL_FIELDS.every((key) => Object.hasOwn(childModel, key)) || Object.keys(childModel).some((key) => !DESCRIPTOR_CHILD_MODEL_FIELDS.includes(key) && key !== "warning")) {
      throw new PreparedDispatchError("descriptor.model_selection.child_model has an invalid schema");
    }
    if (!Object.values(childModel).every((value) => typeof value === "string" && value.trim())) {
      throw new PreparedDispatchError("descriptor.model_selection.child_model fields must be non-empty strings");
    }
  }
  return descriptor;
}
function _verifyPreparedDispatch(descriptorFile) {
  let target = descriptorFile;
  if (isRecord(target)) target = target.descriptor_file;
  const descriptorPath = _descriptorPath(target, "descriptor_file");
  assertRegularFile(descriptorPath, "descriptor_file", { error: PreparedDispatchError });
  const rawDescriptor = _readFile(descriptorPath, "descriptor_file");
  let descriptor;
  try {
    descriptor = JSON.parse(rawDescriptor.toString("utf8"));
  } catch {
    throw new PreparedDispatchError(`descriptor is not valid UTF-8 JSON: ${descriptorPath}`);
  }
  _validateDescriptorShape(descriptor);
  if (descriptor.contract_version !== DESCRIPTOR_CONTRACT_VERSION) {
    throw new PreparedDispatchError("unsupported prepared descriptor contract");
  }
  if (descriptor.state !== "prepared") throw new PreparedDispatchError("prepared descriptor state is not prepared");
  const materialRoot = _descriptorPath(descriptor.material_root, "material_root");
  const producerRoot = _descriptorPath(descriptor.producer_root, "producer_root");
  const expectedRoot = path7.join(
    producerRoot,
    "tmp",
    "dispatch_prepare",
    PREPARATION_DIRECTORY_NAME,
    descriptor.preparation_id
  );
  if (!_pathEqual(materialRoot, expectedRoot)) {
    throw new PreparedDispatchError("material_root does not use the exact preparation layout");
  }
  if (!_isDirectory(materialRoot)) {
    throw new PreparedDispatchError(`material_root is not a directory: ${materialRoot}`);
  }
  _assertNoEscape(materialRoot, producerRoot, { allowMissingLeaf: false });
  if (!_pathEqual(descriptorPath, path7.join(materialRoot, DESCRIPTOR_FILENAME))) {
    throw new PreparedDispatchError("descriptor_file does not match material_root commit marker");
  }
  const paths = {};
  const expectedNames = {
    package_file: PACKAGE_FILENAME,
    task_file: TASK_FILENAME,
    dispatch_file: DISPATCH_FILENAME,
    descriptor_file: DESCRIPTOR_FILENAME
  };
  for (const [key, filename] of Object.entries(expectedNames)) {
    const target2 = _descriptorPath(descriptor[key], key);
    _assertNoEscape(target2, materialRoot, { allowMissingLeaf: false });
    if (pyNormcase(path7.dirname(target2)) !== pyNormcase(materialRoot) || path7.basename(target2) !== filename) {
      throw new PreparedDispatchError(`descriptor.${key} must use the exact v1 filename and containment`);
    }
    paths[key] = target2;
  }
  if (!_pathEqual(paths.descriptor_file, descriptorPath)) {
    throw new PreparedDispatchError("descriptor_file argument does not match descriptor");
  }
  const material = {};
  for (const key of ["package", "task", "dispatch"]) {
    material[key] = _readFile(paths[`${key}_file`], key);
  }
  let pkg2;
  let envelope;
  try {
    pkg2 = JSON.parse(material.package.toString("utf8"));
    envelope = JSON.parse(material.dispatch.toString("utf8"));
  } catch {
    throw new PreparedDispatchError("package or dispatch material is not valid UTF-8 JSON");
  }
  if (!isRecord(pkg2) || !isRecord(envelope)) {
    throw new PreparedDispatchError("package and dispatch material must be JSON objects");
  }
  envelope = validateAsyncDispatchV2(envelope, { package: pkg2 });
  const packageValue = Object.hasOwn(pkg2, "task_package") ? pkg2.task_package : pkg2;
  if (!isRecord(packageValue)) throw new PreparedDispatchError("task_package material must be an object");
  if (packageValue.package_id !== descriptor.package_id) {
    throw new PreparedDispatchError("package_id identity mismatch");
  }
  if (!_pathEqual(envelope.producer_root, producerRoot)) {
    throw new PreparedDispatchError("dispatch producer_root mismatch");
  }
  if (!_pathEqual(envelope.task_file, paths.task_file)) {
    throw new PreparedDispatchError("dispatch task_file mismatch");
  }
  try {
    const taskRootPath = absolutePath(envelope.task_root, "dispatch task_root", { error: PreparedDispatchError });
    const runtimeRoot2 = path7.join(producerRoot, ".runtime");
    if (_relativeUnder(resolveLikePython(runtimeRoot2), taskRootPath) === null) {
      throw new PreparedDispatchError("dispatch task_root is not relative to producer_root/.runtime");
    }
    _assertNoEscape(taskRootPath, runtimeRoot2, { allowMissingLeaf: true });
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) {
      throw new PreparedDispatchError("dispatch task_root must stay inside producer_root/.runtime");
    }
    throw caught;
  }
  if (!_pathEqual(envelope.target_cwd, descriptor.target_cwd)) {
    throw new PreparedDispatchError("target_cwd identity mismatch");
  }
  if (!_pathEqual(envelope.task_root, descriptor.task_root)) {
    throw new PreparedDispatchError("task_root identity mismatch");
  }
  if (descriptor.dispatch_contract_version !== envelope.contract_version) {
    throw new PreparedDispatchError("descriptor dispatch contract mismatch");
  }
  if (descriptor.origin_id !== envelope.origin_thread_id) {
    throw new PreparedDispatchError("origin identity mismatch");
  }
  if (descriptor.batch_id !== envelope.batch_id || descriptor.slice_id !== envelope.slice_id) {
    throw new PreparedDispatchError("batch/slice identity mismatch");
  }
  const selection = descriptor.model_selection;
  if (!_isNone(selection) && ((selection.model ?? null) !== (envelope.model ?? null) || (selection.effort ?? null) !== (envelope.effort ?? null))) {
    throw new PreparedDispatchError("descriptor model selection does not match dispatch envelope");
  }
  const writes = descriptor.writes_performed;
  if (!Array.isArray(writes) || writes.some((value) => typeof value !== "string" || !value.trim())) {
    throw new PreparedDispatchError("descriptor.writes_performed must be a list of non-empty strings");
  }
  const normalizedWrites = [];
  for (const value of writes) {
    const output = path7.isAbsolute(value) ? value : path7.join(materialRoot, value);
    _assertNoEscape(output, materialRoot, { allowMissingLeaf: false });
    const relative = _pureRelative(materialRoot, value);
    if (relative === null) throw new Error(`'${value}' is not in the subpath of '${materialRoot}'`);
    if (normalizedWrites.includes(relative)) {
      throw new PreparedDispatchError("descriptor.writes_performed contains duplicate paths");
    }
    normalizedWrites.push(relative);
  }
  const actualOutputs = _collectWorkspaceOutputs(materialRoot);
  const left = new Set(normalizedWrites);
  const right = new Set(actualOutputs);
  if (left.size !== right.size || [...left].some((value) => !right.has(value))) {
    throw new PreparedDispatchError("descriptor writes_performed does not match the preparation tree");
  }
  _validatePackageEvidencePath(pkg2, {
    producerRoot,
    materialRoot,
    preparedOutputs: normalizedWrites
  });
  return descriptor;
}
function verifyPreparedDispatch(descriptorFile) {
  try {
    return _verifyPreparedDispatch(descriptorFile);
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) throw caught;
    throw new PreparedDispatchError(`malformed prepared dispatch descriptor: ${caught?.message ?? caught}`);
  }
}
function _discardUntrustedDescriptorMarker(materialRoot) {
  const root = absolutePath(materialRoot, "material_root", { error: PreparedDispatchError });
  if (!OWNED_UNCOMMITTED_ROOTS.has(pyNormcase(root))) return;
  const marker = path7.join(root, DESCRIPTOR_FILENAME);
  let info;
  try {
    info = lstatSync2(marker);
  } catch (caught) {
    if (caught?.code === "ENOENT") return;
    throw new PreparedDispatchError(`cannot inspect untrusted descriptor marker: ${marker}: ${caught.message}`);
  }
  try {
    if (info.isDirectory() && !info.isSymbolicLink() && !isReparseStat(info)) {
      _iterWorkspaceFiles(marker);
      rmSync3(marker, { recursive: true });
    } else {
      unlinkSync2(marker);
    }
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) throw caught;
    if (caught?.code === "EISDIR") {
      rmdirSync(marker);
      return;
    }
    throw new PreparedDispatchError(`cannot discard untrusted descriptor marker: ${marker}: ${caught.message}`);
  }
}
function cleanupUncommittedPreparation(materialRoot, { producerRoot = null } = {}) {
  const root = absolutePath(materialRoot, "material_root", { error: PreparedDispatchError });
  let producer;
  if (_isNone(producerRoot)) {
    const parents = _parentsOf(root);
    producer = parents.length > 3 ? parents[3] : parents[0];
  } else {
    producer = absolutePath(producerRoot, "producer_root", { error: PreparedDispatchError });
  }
  _assertNoEscape(root, producer, { allowMissingLeaf: false });
  const ownedRoot = pyNormcase(root);
  if (!OWNED_UNCOMMITTED_ROOTS.has(ownedRoot)) return false;
  const descriptor = path7.join(root, DESCRIPTOR_FILENAME);
  let descriptorInfo = null;
  try {
    descriptorInfo = lstatSync2(descriptor);
  } catch (caught) {
    if (caught?.code !== "ENOENT") {
      OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
      return false;
    }
  }
  if (descriptorInfo !== null) {
    OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
    return false;
  }
  try {
    _iterWorkspaceFiles(root);
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) {
      OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
      return false;
    }
    throw caught;
  }
  try {
    rmSync3(root, { recursive: true });
  } catch (caught) {
    if (caught?.code === "ENOENT") {
      OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
      return true;
    }
    throw caught;
  }
  OWNED_UNCOMMITTED_ROOTS.delete(ownedRoot);
  try {
    lstatSync2(root);
  } catch (caught) {
    if (caught?.code === "ENOENT") return true;
    return false;
  }
  return false;
}
var DESCRIPTOR_CONTRACT_VERSION, DISPATCH_CONTRACT_VERSION, PREPARATION_DIRECTORY_NAME, PREPARATION_PREFIX, PREPARATION_ALLOCATION_RETRIES, PACKAGE_FILENAME, TASK_FILENAME, DISPATCH_FILENAME, DESCRIPTOR_FILENAME, RESERVED_FILENAMES, OWNED_UNCOMMITTED_ROOTS, PreparedDispatchError, ASYNC_DISPATCH_V2_FIELDS, SELECTION_FIELDS, ASYNC_DISPATCH_REQUIRED_FIELDS, ASYNC_CONTEXT_MODES, ASYNC_EXECUTION_PROFILES, ASYNC_RESULT_MODES, SIMULATION_FIELDS, DESCRIPTOR_MODEL_SELECTION_FIELDS, DESCRIPTOR_CHILD_MODEL_FIELDS, _writeAdapter, RUNTIME_VALUE_ALIASES;
var init_prepared_dispatch = __esm({
  "ops/tools/dispatch-core/prepared_dispatch.mjs"() {
    init_tool_common();
    init_py();
    DESCRIPTOR_CONTRACT_VERSION = "prepared-dispatch-descriptor/v1";
    DISPATCH_CONTRACT_VERSION = "async-dispatch/v2";
    PREPARATION_DIRECTORY_NAME = "preparations";
    PREPARATION_PREFIX = "prep-";
    PREPARATION_ALLOCATION_RETRIES = 8;
    PACKAGE_FILENAME = "package.json";
    TASK_FILENAME = "package.task.md";
    DISPATCH_FILENAME = "package.dispatch.json";
    DESCRIPTOR_FILENAME = "prepared-dispatch.json";
    RESERVED_FILENAMES = Object.freeze([PACKAGE_FILENAME, TASK_FILENAME, DISPATCH_FILENAME, DESCRIPTOR_FILENAME]);
    OWNED_UNCOMMITTED_ROOTS = /* @__PURE__ */ new Set();
    PreparedDispatchError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "PreparedDispatchError";
      }
    };
    ASYNC_DISPATCH_V2_FIELDS = Object.freeze([
      "contract_version",
      "producer_root",
      "origin_thread_id",
      "target_cwd",
      "task_file",
      "task_root",
      "runner_path",
      "runtime_role",
      "model",
      "effort",
      "context_mode",
      "execution_profile",
      "result_mode",
      "simulation",
      "budget",
      "batch_id",
      "slice_id",
      "display_title",
      "save_raw_evidence",
      "turn_timeout_ms",
      "stall_silence_ms",
      "selection"
    ]);
    SELECTION_FIELDS = Object.freeze([
      "requested",
      "role",
      "capability",
      "pick",
      "config_source",
      "resolved_model",
      "resolved_effort",
      "effort_source",
      "efforts",
      "effort_range",
      "authorization"
    ]);
    ASYNC_DISPATCH_REQUIRED_FIELDS = Object.freeze([
      "contract_version",
      "producer_root",
      "origin_thread_id",
      "target_cwd",
      "task_file",
      "task_root"
    ]);
    ASYNC_CONTEXT_MODES = Object.freeze(["isolated", "project-aware"]);
    ASYNC_EXECUTION_PROFILES = Object.freeze(["standard", "simulation", "evidence_only_v1"]);
    ASYNC_RESULT_MODES = Object.freeze(["", "read_only_audit", "simulated_planning", "real_rerun"]);
    SIMULATION_FIELDS = Object.freeze(["role", "persona"]);
    DESCRIPTOR_MODEL_SELECTION_FIELDS = Object.freeze([
      "model",
      "effort",
      "model_source",
      "effort_source",
      "child_model"
    ]);
    DESCRIPTOR_CHILD_MODEL_FIELDS = Object.freeze(["status", "source"]);
    _writeAdapter = {
      write(target, data) {
        atomicWriteBytes(target, data, { error: PreparedDispatchError });
      }
    };
    RUNTIME_VALUE_ALIASES = Object.freeze({
      target_cwd: "targetCwd",
      task_root: "taskRoot",
      runner_path: "runnerPath",
      runtime_role: "runtimeRole",
      context_mode: "contextMode",
      execution_profile: "executionProfile",
      result_mode: "resultMode"
    });
  }
});

// ops/tools/dispatch-core/task_package_profiles.mjs
import { existsSync as existsSync4, readdirSync as readdirSync4, statSync as statSync6 } from "node:fs";
import path8 from "node:path";
function valueError(message) {
  return pyError("ValueError", message);
}
function relRoute(routeFile) {
  return path8.relative(ROOT, routeFile).replace(/\\/g, "/");
}
function routeIdFromAgent(role, capability) {
  return `${role}__${capability}`;
}
function blockScalar(text3, routeFile) {
  const match = AGENT_BLOCK_RE2.exec(text3);
  if (!match) throw valueError(`${relRoute(routeFile)} missing yaml task_package_agent block`);
  return match[1];
}
function parseCard(text3, routeFile) {
  const match = CARD_RE2.exec(text3);
  if (!match) return null;
  const rel2 = relRoute(routeFile);
  let card;
  try {
    card = pyJsonLoads(match[1]);
  } catch (error) {
    throw valueError(`${rel2} route_card block is not valid JSON: ${error.message}`);
  }
  if (!isRecord(card)) throw valueError(`${rel2} route_card must be a JSON object`);
  const required = pyGet(card, "required", []);
  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  const needsSlot = pyTruthy(pyGet(card, "contract_defaults")) || pyTruthy(pyGet(card, "required_files_by_contract")) || required.some((req) => isRecord(req) && pyStr(pyGet(req, "path", "")).startsWith("contract."));
  if (needsSlot && !slot) throw valueError(`${rel2} route_card uses contract fields but has no slot`);
  for (const req of required) {
    if (!isRecord(req) || !pyStr(pyGet(req, "path", "")).trim()) {
      throw valueError(`${rel2} route_card required entries need a path`);
    }
  }
  const seedDefaults = isRecord(pyGet(card, "seed_defaults")) ? pyGet(card, "seed_defaults") : {};
  const expectedDefaults = isRecord(pyGet(seedDefaults, "expected_output")) ? pyGet(seedDefaults, "expected_output") : {};
  const businessGate = pyStr(pyOr(pyGet(expectedDefaults, "business_gate"), "")).trim();
  if (businessGate && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(businessGate)) {
    throw valueError(`${rel2} expected_output.business_gate must be a bare field name`);
  }
  const requiredByContract = pyGet(card, "required_files_by_contract", null);
  if (requiredByContract !== null && requiredByContract !== void 0) {
    const keys = isRecord(requiredByContract) ? Object.keys(requiredByContract).sort() : null;
    if (!keys || keys.length !== 2 || keys[0] !== "map" || keys[1] !== "path") {
      throw valueError(`${rel2} required_files_by_contract must contain path and map`);
    }
    const contractPath = pyStr(pyOr(pyGet(requiredByContract, "path"), "")).trim();
    const mapping = pyGet(requiredByContract, "map");
    if (!contractPath || !isRecord(mapping) || !pyTruthy(mapping)) {
      throw valueError(`${rel2} required_files_by_contract needs a contract path and non-empty map`);
    }
    for (const [value, promptPath] of Object.entries(mapping)) {
      if (!pyStr(value).trim() || typeof promptPath !== "string" || !promptPath.startsWith("ops/agent-prompts/")) {
        throw valueError(`${rel2} required_files_by_contract has an invalid mapping`);
      }
      const target = path8.join(RUNTIME_ROOT, promptPath);
      if (!(existsSync4(target) && statSync6(target).isFile())) {
        throw valueError(`${rel2} conditional required file missing: ${promptPath}`);
      }
    }
  }
  return card;
}
function parseAgentBlock(block, routeFile) {
  let role = "";
  let runtimeRole = "";
  let capabilityName = "";
  let capabilityFile = "";
  const requiredFiles = [];
  let section = "";
  for (const rawLine of pySplitLines(block)) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#") || stripped === "agent:") continue;
    if (stripped === "capability:") {
      section = "capability";
      continue;
    }
    if (stripped === "required_files:") {
      section = "required_files";
      continue;
    }
    if (section === "required_files" && stripped.startsWith("- ")) {
      requiredFiles.push(stripped.slice(2).trim());
      continue;
    }
    const colon = stripped.indexOf(":");
    if (colon === -1) continue;
    const key = stripped.slice(0, colon);
    const value = pyStripChars(stripped.slice(colon + 1).trim(), `"'`);
    if (section === "capability" && key === "name") capabilityName = value;
    else if (section === "capability" && key === "file") capabilityFile = value;
    else if (key === "role") {
      section = "agent";
      role = value;
    } else if (key === "runtime_role") {
      section = "agent";
      runtimeRole = value;
    }
  }
  const rel2 = relRoute(routeFile);
  const missing = [];
  if (!role) missing.push("agent.role");
  if (!runtimeRole) missing.push("agent.runtime_role");
  if (!capabilityName) missing.push("agent.capability.name");
  if (!capabilityFile) missing.push("agent.capability.file");
  if (!requiredFiles.length) missing.push("agent.required_files");
  if (missing.length) throw valueError(`${rel2} task_package_agent missing: ${missing.join(", ")}`);
  return {
    role,
    runtime_role: runtimeRole,
    capability: { name: capabilityName, file: capabilityFile },
    required_files: requiredFiles
  };
}
function routeProfile(routeFile) {
  const routeId2 = path8.basename(routeFile, ".md");
  const text3 = pyReadText(routeFile);
  const agent = parseAgentBlock(blockScalar(text3, routeFile), routeFile);
  const expectedRoute = routeIdFromAgent(agent.role, agent.capability.name);
  const relRouteFile = relRoute(routeFile);
  if (expectedRoute !== routeId2) {
    throw valueError(`${relRouteFile} file name does not match task_package_agent: expected ${expectedRoute}`);
  }
  return {
    route_id: routeId2,
    agent,
    role: agent.role,
    runtime_role: agent.runtime_role,
    capability: agent.capability.name,
    prompt_file: agent.capability.file,
    route_file: relRouteFile,
    required_files: agent.required_files,
    card: parseCard(text3, routeFile)
  };
}
function loadRouteProfiles() {
  if (!(existsSync4(ROUTE_DIR) && statSync6(ROUTE_DIR).isDirectory())) {
    throw valueError(`route directory not found: ${path8.relative(RUNTIME_ROOT, ROUTE_DIR).replace(/\\/g, "/")}`);
  }
  const profiles = {};
  const names = readdirMd(ROUTE_DIR).sort();
  for (const name of names) {
    const profile = routeProfile(path8.join(ROUTE_DIR, name));
    profiles[profile.route_id] = profile;
  }
  if (!Object.keys(profiles).length) throw valueError("no task package routes found");
  return profiles;
}
function readdirMd(dir) {
  return readdirSync4(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
}
function profileCacheKey() {
  return `${ROOT}\0${RUNTIME_ROOT}`;
}
function routeProfiles() {
  const key = profileCacheKey();
  if (!PROFILE_CACHE.has(key)) PROFILE_CACHE.set(key, loadRouteProfiles());
  return PROFILE_CACHE.get(key);
}
function profileFor(routeId2) {
  const profiles = routeProfiles();
  if (!Object.hasOwn(profiles, routeId2)) {
    const supported = Object.keys(profiles).sort().join(", ");
    throw pyKeyError(`unsupported route_id ${pyRepr(routeId2)}; supported: ${supported}`);
  }
  return profiles[routeId2];
}
var ROUTE_DIR, SEED_BODY_REQUIRED, AGENT_BLOCK_RE2, CARD_RE2, PROFILE_CACHE;
var init_task_package_profiles = __esm({
  "ops/tools/dispatch-core/task_package_profiles.mjs"() {
    init_tool_common();
    init_py();
    ROUTE_DIR = path8.join(RUNTIME_ROOT, "ops", "protocols", "task-package-routes");
    SEED_BODY_REQUIRED = [
      "project_positioning",
      "goal",
      "scope",
      "ownership",
      "concurrency_contract",
      "inputs",
      "known_facts",
      "expected_output",
      "runtime_context",
      "alignment",
      "planning_policy",
      "tool_contract",
      "stop_conditions",
      "extensions",
      "handoff_contract"
    ];
    AGENT_BLOCK_RE2 = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
    CARD_RE2 = /```json\s+route_card\s*\n([\s\S]*?)\n```/;
    PROFILE_CACHE = /* @__PURE__ */ new Map();
  }
});

// ops/tools/dispatch-core/task_package_build.mjs
import { existsSync as existsSync5, mkdirSync as mkdirSync5, writeFileSync as writeFileSync3 } from "node:fs";
import path9 from "node:path";
function readProjectName() {
  const projectFile = path9.join(ROOT, "PROJECT.md");
  if (!existsSync5(projectFile)) return "<\u9879\u76EE\u540D>";
  const lines = pySplitLines(pyReadTextReplace(projectFile));
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].trim() !== "## \u9879\u76EE\u540D\u79F0") continue;
    for (const candidate of lines.slice(idx + 1)) {
      const value = candidate.trim();
      if (value && !value.startsWith("#")) return value;
    }
    break;
  }
  return "<\u9879\u76EE\u540D>";
}
function stringList(value, label) {
  if (!Array.isArray(value)) throw new ToolError(`${label} must be a list`);
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") throw new ToolError(`${label} entries must be strings`);
    result.push(item);
  }
  return result;
}
function packageId(routeId2, seed) {
  if (pyTruthy(pyGet(seed, "package_id"))) return pyStr(pyGetItem(seed, "package_id"));
  const now = clock.now();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${utcDateStamp()}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `pkg-${String(routeId2).replaceAll("__", "-")}-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}
function truthyText(value) {
  const base = pyTruthy(value) ? value : "";
  return TRUTHY_TEXT.has(pyStrip(pyStr(base)).toLowerCase());
}
var TRUTHY_TEXT;
var init_task_package_build = __esm({
  "ops/tools/dispatch-core/task_package_build.mjs"() {
    init_tool_common();
    init_py();
    init_task_package_profiles();
    TRUTHY_TEXT = /* @__PURE__ */ new Set(["1", "true", "yes", "y", "on"]);
  }
});

// ops/tools/dispatch-core/review_evidence.mjs
import { spawnSync as spawnSync3 } from "node:child_process";
import { opendirSync, readdirSync as readdirSync5, statSync as statSync7 } from "node:fs";
import path10 from "node:path";
import process6 from "node:process";
function statOrNull2(value) {
  try {
    return statSync7(value);
  } catch {
    return null;
  }
}
function pathExists(value) {
  return statOrNull2(value) !== null;
}
function pathIsDir(value) {
  return Boolean(statOrNull2(value)?.isDirectory());
}
function decodeTruncated(buffer, limit) {
  const cap = Math.max(0, Math.min(limit, buffer.length));
  let end = cap;
  if (cap < buffer.length) {
    let index = cap - 1;
    let trailing = 0;
    while (index >= 0 && (buffer[index] & 192) === 128) {
      index -= 1;
      trailing += 1;
    }
    if (index >= 0) {
      const lead = buffer[index];
      const needed = lead >= 240 ? 3 : lead >= 224 ? 2 : lead >= 192 ? 1 : 0;
      if (trailing < needed) end = index;
    }
  }
  return buffer.subarray(0, end).toString("utf8");
}
function assertReviewRoutesConsistent(routes = null) {
  const checked = routes === null || routes === void 0 ? REVIEW_ROUTES : routes;
  for (const [rid, spec] of Object.entries(checked)) {
    const kind = isRecord(spec) ? spec.kind : void 0;
    if (!["evidence", "semantic"].includes(kind)) {
      throw new ToolError(`REVIEW_ROUTES[${rid}].kind \u4E0D\u5728\u95ED\u96C6 evidence|semantic: ${pyRepr(kind ?? null)}`);
    }
    const slot = isRecord(spec) ? spec.contract_slot : void 0;
    if (typeof slot !== "string" || !slot.trim()) {
      throw new ToolError(`REVIEW_ROUTES[${rid}].contract_slot \u7F3A\u5931\u6216\u4E3A\u7A7A`);
    }
  }
  return null;
}
function assertNoReparse(value, { allowMissing = false } = {}) {
  assertNoReparseComponents(value, { allowMissing, label: "evidence path" });
}
function ensureDirectory(value) {
  return ensureControlledDirectory(value, { label: "evidence directory" });
}
function routeId(pkg2) {
  const agent = isRecord(pkg2?.agent) ? pkg2.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const role = String(agent.role || "");
  const name = String(capability.name || "");
  return `${role}__${name}`;
}
function capabilityContract(pkg2, rid) {
  const extensions = isRecord(pkg2?.extensions) ? pkg2.extensions : {};
  const contracts = isRecord(extensions.capability_contract) ? extensions.capability_contract : {};
  if (!Object.hasOwn(CONTRACT_SLOTS, rid)) throw pyError("KeyError", pyRepr(rid));
  const value = contracts[CONTRACT_SLOTS[rid]];
  return isRecord(value) ? value : {};
}
function isStaticReview(pkg2) {
  const rid = routeId(pkg2);
  if (!STATIC_REVIEW_ROUTES.has(rid)) return false;
  if (rid === "verify-agent__code-verification") {
    const contract = capabilityContract(pkg2, rid);
    if (contract.verify_mode !== "verification") return false;
    const acceptance = contract.acceptance_context;
    return !(isRecord(acceptance) && Object.keys(acceptance).length > 0);
  }
  return true;
}
function reviewRoot(pkg2) {
  const runtime = isRecord(pkg2?.runtime_context) ? pkg2.runtime_context : {};
  const target = runtime.target_repo;
  if (typeof target === "string" && target.trim()) return resolveLikePython(target);
  const cwd = runtime.cwd;
  if (typeof cwd === "string" && cwd.trim()) return resolveLikePython(cwd);
  return resolveLikePython(ROOT);
}
function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim() && !result.includes(value)) result.push(value);
  }
  return result;
}
function declaredTargets(contract) {
  const values = [];
  for (const key of TARGET_KEYS) {
    const item = contract?.[key];
    if (Array.isArray(item)) values.push(...item);
  }
  return uniqueStrings(values);
}
function resolveScopedPath(root, value) {
  const rootPath = lexicalAbsolute(root);
  const target = isAbsoluteLikePython(value) ? lexicalAbsolute(value) : lexicalAbsolute(pathlibJoin(rootPath, value));
  assertNoReparse(rootPath, { allowMissing: true });
  assertNoReparse(target, { allowMissing: true });
  const resolved = resolveLikePython(target);
  const resolvedRoot = resolveLikePython(rootPath);
  if (!pyIsRelativeTo(resolved, resolvedRoot)) {
    throw new ToolError(
      `review evidence path escapes review root: ${value} (review root: ${resolvedRoot}; \u76EE\u6807\u5728\u53E6\u4E00\u4ED3\u65F6\u7528 dispatch_prepare --async-target-cwd \u6307\u5411\u8BE5\u4ED3\uFF0Cscope \u5199\u8BE5\u4ED3\u5185\u8DEF\u5F84)`
    );
  }
  return target;
}
function relTo(root, target) {
  return pyRelativeToPosix(resolveLikePython(target), resolveLikePython(root));
}
function run(argv, cwd, timeout = 30) {
  const started = process6.hrtime.bigint();
  const elapsed = () => Math.round(Number(process6.hrtime.bigint() - started) / 1e6 * 1e3) / 1e3;
  const command = argv.map(String);
  const completed = spawnSync3(command[0], command.slice(1), {
    cwd: String(cwd),
    encoding: "utf8",
    timeout: Math.round(pyFloat(timeout) * 1e3),
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (completed.error) {
    if (completed.error.code === "ETIMEDOUT" || completed.signal) {
      return {
        exit_code: null,
        stdout: String(completed.stdout ?? ""),
        stderr: String(completed.stderr ?? ""),
        timed_out: true,
        duration_ms: elapsed()
      };
    }
    return {
      exit_code: null,
      stdout: "",
      stderr: String(completed.error.message ?? completed.error),
      timed_out: false,
      duration_ms: elapsed()
    };
  }
  return {
    exit_code: completed.status,
    stdout: String(completed.stdout ?? ""),
    stderr: String(completed.stderr ?? ""),
    timed_out: false,
    duration_ms: elapsed()
  };
}
function git(root, args, timeout = 30) {
  return run(["git", "-C", String(root), ...args], root, timeout);
}
function tail(text3, limit = 600) {
  const value = String(text3 || "");
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return [...value].slice(-limit).join("");
}
function checkOutputSummary(stdout, stderr, limit = 2e3) {
  const combined = `${stdout || ""}${stderr || ""}`.trim();
  if (!combined) return "";
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ""));
  } catch {
    return tail(combined, limit);
  }
  if (!isRecord(parsed)) return tail(pyJsonDumps(parsed, { compact: true }), limit);
  const summary = {};
  for (const key of ["status", "ok", "applied", "build_id", "windows_path_replacement", "verification", "metrics"]) {
    if (Object.hasOwn(parsed, key)) summary[key] = parsed[key];
  }
  const checks = parsed.checks;
  if (isRecord(checks)) {
    const failed = Object.entries(checks).filter(([, value]) => value === false).map(([key]) => String(key));
    summary.checks = { total: Object.keys(checks).length, failed };
  }
  const compact = pyJsonDumps(Object.keys(summary).length ? summary : parsed, { compact: true });
  return tail(compact, limit);
}
function surfacePath(surface, candidates) {
  const normalized = String(surface).replace(/\\/g, "/");
  const matches2 = candidates.filter((item) => normalized.includes(String(item).replace(/\\/g, "/")));
  if (!matches2.length) return null;
  let best = matches2[0];
  for (const item of matches2) if (item.length > best.length) best = item;
  return best;
}
function surfaceExcerpt(target, surface, maxLines = 10) {
  const lines = pySplitLines(pyReadTextReplace(target));
  const text3 = String(surface);
  const descriptor = text3.includes(":") ? text3.slice(text3.indexOf(":") + 1) : text3;
  const rangeMatch = SURFACE_RANGE_RE.exec(descriptor);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    let end = Number(rangeMatch[2]);
    if (start >= 1 && start <= end) {
      end = Math.min(end, lines.length, start + SURFACE_RANGE_MAX_LINES - 1);
      if (start <= lines.length) {
        const picked = [];
        for (let index = start - 1; index < end; index += 1) picked.push(`${index + 1}: ${lines[index]}`);
        return { surface: text3, lines: picked };
      }
    }
  }
  const tokens = uniqueStrings(
    (descriptor.match(TOKEN_RE) || []).filter((token) => !["path", "file", "line"].includes(token.toLowerCase())).map((token) => token.toLowerCase())
  );
  const scored = [];
  lines.forEach((line, index) => {
    const folded = line.toLowerCase();
    const matched = tokens.filter((token) => folded.includes(token));
    if (matched.length) scored.push([matched.length, matched.reduce((sum, token) => sum + token.length, 0), index]);
  });
  scored.sort((left, right) => right[0] - left[0] || right[1] - left[1] || left[2] - right[2]);
  let hits = scored.slice(0, 2).map((item) => item[2]);
  if (!hits.length) hits = lines.length ? [0] : [];
  const selected = [];
  for (const hit of hits.slice(0, 2)) {
    for (let index = Math.max(0, hit - 1); index < Math.min(lines.length, hit + 2); index += 1) {
      if (!selected.includes(index)) selected.push(index);
      if (selected.length >= maxLines) break;
    }
    if (selected.length >= maxLines) break;
  }
  return { surface: text3, lines: selected.map((index) => `${index + 1}: ${lines[index]}`) };
}
function sourceEvidence(root, rid, contract, scopeRead, byteBudget) {
  const targets = declaredTargets(contract);
  const changed = Array.isArray(contract?.changed_surfaces) ? uniqueStrings(contract.changed_surfaces) : [];
  const items = [];
  const errors = [];
  let used = 0;
  let complete = true;
  for (const value of uniqueStrings([...targets, ...scopeRead])) {
    let target;
    try {
      target = resolveScopedPath(root, value);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      errors.push(error.message);
      complete = false;
      continue;
    }
    const entry = { path: value };
    if (!pathExists(target)) {
      entry.exists = false;
      errors.push(`missing review source: ${value}`);
      complete = false;
      items.push(entry);
      continue;
    }
    if (pathIsDir(target)) {
      entry.kind = "directory";
      entry.entries = readdirSync5(target).length;
      complete = false;
      items.push(entry);
      continue;
    }
    const matchingSurfaces = changed.filter((surface) => surfacePath(surface, [value]));
    if (matchingSurfaces.length) {
      entry.excerpts = matchingSurfaces.map((surface) => surfaceExcerpt(target, surface));
      const encoded = Buffer.byteLength(pyJsonDumps(entry.excerpts), "utf8");
      if (used + encoded > byteBudget) {
        entry.excerpts = entry.excerpts.slice(0, 1);
        entry.truncated = true;
        complete = false;
      } else {
        used += encoded;
      }
    }
    if (targets.includes(value)) {
      const content = pyReadTextReplace(target);
      const encoded = Buffer.from(content, "utf8");
      const remaining = Math.max(0, byteBudget - used);
      if (encoded.length <= remaining) {
        entry.content = content;
        used += encoded.length;
      } else {
        entry.content = decodeTruncated(encoded, remaining);
        entry.truncated = true;
        complete = false;
        used = byteBudget;
      }
    }
    items.push(entry);
  }
  return [items, errors, complete];
}
function estimatedTokens(value) {
  const payload = pyJsonDumps(value, { compact: true });
  return Math.floor((Buffer.byteLength(payload, "utf8") + 2) / 3);
}
function compareNormPath(left, right) {
  const a = pyNormcase(left);
  const b = pyNormcase(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function noteUnenumeratedDirectory(state, abs, reason) {
  state.skipped = true;
  if (state.unenumeratedDirectories.length >= SEMANTIC_OMISSION_DIR_CAP) {
    state.unenumeratedDirectoryOverflow += 1;
    return;
  }
  let relative = abs;
  try {
    relative = relTo(state.root, abs);
  } catch {
  }
  state.unenumeratedDirectories.push({ path: relative, reason });
}
function addSemanticFile(state, abs, role, options = {}) {
  const relative = relTo(state.root, abs);
  const seenKey = pyNormcase(abs);
  const declaredFile = options.declaredFile === true;
  if (state.seen.has(seenKey)) {
    const entry = state.items.get(relative);
    if (!entry && declaredFile) {
      let bytes2 = 0;
      try {
        bytes2 = statSync7(abs).size;
      } catch {
        bytes2 = 0;
      }
      state.meta.set(relative, { abs, bytes: bytes2 });
      state.items.set(relative, { path: relative, declared_as: [role] });
      return;
    }
    if (entry && !entry.declared_as.includes(role)) entry.declared_as.push(role);
    return;
  }
  state.seen.add(seenKey);
  let bytes = 0;
  try {
    bytes = statSync7(abs).size;
  } catch {
    bytes = 0;
  }
  state.enumeratedFiles += 1;
  state.enumeratedBytes += bytes;
  if (!declaredFile && state.storedExpanded >= SEMANTIC_COMPLETE_INDEX_FILE_CAP) {
    state.overCap = true;
    state.omittedFileCount += 1;
    return;
  }
  if (!declaredFile) state.storedExpanded += 1;
  state.meta.set(relative, { abs, bytes });
  state.items.set(relative, { path: relative, declared_as: [role] });
}
function walkSemanticDirectory(state, dir, role) {
  const found = [];
  let streaming = false;
  const visitFile = (full) => {
    if (streaming) {
      addSemanticFile(state, full, role);
      return;
    }
    found.push(full);
    if (found.length > SEMANTIC_COMPLETE_INDEX_FILE_CAP) {
      streaming = true;
      for (const item of found) addSemanticFile(state, item, role);
      found.length = 0;
    }
  };
  const walk = (current) => {
    let handle;
    try {
      handle = opendirSync(current);
    } catch {
      return;
    }
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const full = path10.join(current, entry.name);
        if (entry.isDirectory()) {
          const reason = REGENERATED_TREE_REASONS.get(entry.name);
          if (reason) {
            noteUnenumeratedDirectory(state, full, reason);
            continue;
          }
          walk(full);
          continue;
        }
        visitFile(full);
      }
    } catch {
      noteUnenumeratedDirectory(state, current, "unreadable");
    } finally {
      handle.closeSync();
    }
  };
  walk(dir);
  if (!streaming) {
    found.sort(compareNormPath);
    for (const item of found) addSemanticFile(state, item, role);
  }
}
function finalizeSemanticSources(state) {
  const enumerationComplete = !state.skipped && !state.overCap && state.omittedFileCount === 0;
  const scopeDirectoryDeclared = state.scopeReadDirectories.length > 0;
  const fullCandidate = !scopeDirectoryDeclared && enumerationComplete && state.enumeratedBytes <= SEMANTIC_FULL_CONTENT_BYTE_CEILING && projectedSemanticTokens(state.enumeratedBytes, state.enumeratedFiles) <= SEMANTIC_INJECTION_TOKEN_LIMIT;
  const mode = fullCandidate ? "full_candidate" : enumerationComplete ? "complete_index" : "bounded_index";
  if (mode === "full_candidate") {
    for (const [relative, entry] of state.items) {
      const meta = state.meta.get(relative);
      entry.content = pyReadTextReplace(meta.abs);
      state.contentBytesRead += meta.bytes;
    }
  } else {
    let remaining = SEMANTIC_TARGET_CONTENT_BYTE_BUDGET;
    for (const [relative, entry] of state.items) {
      if (!entry.declared_as.includes("target")) continue;
      const meta = state.meta.get(relative);
      if (meta.bytes <= remaining) {
        entry.content = pyReadTextReplace(meta.abs);
        remaining -= meta.bytes;
        state.contentBytesRead += meta.bytes;
      } else {
        state.targetContentOmitted.push(relative);
      }
    }
  }
  return {
    mode,
    scopeDirectoryDeclared,
    scopeReadDirectories: state.scopeReadDirectories,
    enumerationComplete,
    enumeratedFiles: state.enumeratedFiles,
    enumeratedBytes: state.enumeratedBytes,
    omittedFileCount: state.omittedFileCount,
    unenumeratedDirectories: state.unenumeratedDirectories,
    unenumeratedDirectoryOverflow: state.unenumeratedDirectoryOverflow,
    contentBytesRead: state.contentBytesRead,
    targetContentOmitted: state.targetContentOmitted
  };
}
function semanticSourceEvidence(root, contract, scopeRead) {
  const state = {
    root,
    items: /* @__PURE__ */ new Map(),
    meta: /* @__PURE__ */ new Map(),
    seen: /* @__PURE__ */ new Set(),
    enumeratedFiles: 0,
    enumeratedBytes: 0,
    omittedFileCount: 0,
    storedExpanded: 0,
    overCap: false,
    skipped: false,
    unenumeratedDirectories: [],
    unenumeratedDirectoryOverflow: 0,
    contentBytesRead: 0,
    targetContentOmitted: [],
    scopeReadDirectories: []
  };
  const errors = [];
  const declarations = [
    ...declaredTargets(contract).map((value) => [value, "target"]),
    ...scopeRead.map((value) => [value, "scope_read"])
  ];
  for (const [value, role] of declarations) {
    let declaredPath;
    try {
      declaredPath = resolveScopedPath(root, value);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      errors.push(error.message);
      continue;
    }
    if (!pathExists(declaredPath)) {
      errors.push(`missing review source: ${value}`);
      continue;
    }
    if (pathIsDir(declaredPath)) {
      if (role === "scope_read") {
        try {
          state.scopeReadDirectories.push(relTo(root, declaredPath));
        } catch {
          state.scopeReadDirectories.push(String(value));
        }
      }
      walkSemanticDirectory(state, declaredPath, role);
    } else addSemanticFile(state, declaredPath, role, { declaredFile: true });
  }
  semanticScanSlot = finalizeSemanticSources(state);
  return [[...state.items.values()], errors, errors.length === 0];
}
function scopedGitEvidence(root, paths, patchBudget, changeBase = null) {
  let repoPaths = [];
  for (const value of paths) {
    let target;
    try {
      target = resolveScopedPath(root, value);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      continue;
    }
    if (pyIsRelativeTo(target, root)) repoPaths.push(relTo(root, target));
  }
  repoPaths = uniqueStrings(repoPaths);
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exit_code !== 0) {
    return { mode: "not_a_repo", path_count: repoPaths.length, error: tail(inside.stderr) };
  }
  let base = null;
  if (changeBase !== null) {
    const resolved = git(root, ["rev-parse", "--verify", "--end-of-options", `${changeBase}^{commit}`]);
    if (resolved.exit_code !== 0) {
      return { mode: "invalid_base", change_base: changeBase, path_count: repoPaths.length, error: tail(resolved.stderr) };
    }
    base = String(resolved.stdout || "").trim();
  }
  const diffFrom = base ?? "HEAD";
  const suffix = repoPaths.length ? ["--", ...repoPaths] : [];
  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--short", "--untracked-files=all", ...suffix]);
  const stat = git(root, ["diff", "--stat", diffFrom, ...suffix]);
  const result = {
    mode: "git",
    base,
    head: String(head.stdout || "").trim(),
    path_count: repoPaths.length,
    scoped_status: pySplitLines(String(status.stdout || "")),
    diff_stat: String(stat.stdout || "").trim()
  };
  if (patchBudget > 0) {
    const patch = git(root, ["diff", "--no-ext-diff", "--unified=2", diffFrom, ...suffix]);
    const patchText = String(patch.stdout || "");
    const patchBuffer = Buffer.from(patchText, "utf8");
    result.patch_excerpt = decodeTruncated(patchBuffer, patchBudget);
    result.patch_bytes = patchBuffer.length;
    result.patch_truncated = patchBuffer.length > patchBudget;
  }
  return result;
}
function validateCheck(raw, root) {
  if (!isRecord(raw)) throw new ToolError("mechanical_checks entries must be objects");
  const checkId = String(raw.id || "").trim();
  const argv = raw.argv;
  if (!checkId || !Array.isArray(argv) || !argv.length || !argv.every((item) => typeof item === "string" && item)) {
    throw new ToolError("mechanical check requires id and non-empty string argv");
  }
  const cwd = resolveScopedPath(root, String(raw.cwd || "."));
  if (!pathIsDir(cwd)) throw new ToolError(`mechanical check cwd is not a directory: ${cwd}`);
  const timeout = pyFloat(Object.hasOwn(raw, "timeout_seconds") ? raw.timeout_seconds : 120);
  if (timeout <= 0 || timeout > 600) throw new ToolError("mechanical check timeout_seconds must be in (0, 600]");
  const expected = Object.hasOwn(raw, "expected_exit_codes") ? raw.expected_exit_codes : [0];
  if (!Array.isArray(expected) || !expected.length || !expected.every((item) => typeof item === "boolean" || typeof item === "number" && Number.isInteger(item))) {
    throw new ToolError("mechanical check expected_exit_codes must be a non-empty integer list");
  }
  const codes = [...new Set(expected.map((item) => typeof item === "boolean" ? Number(item) : item))].sort(
    (left, right) => left - right
  );
  return [checkId, argv, cwd, timeout, codes];
}
function atomicWriteBytes2(target, payload) {
  const destination = lexicalAbsolute(target);
  try {
    atomicWriteBytes(destination, payload, { ensureParent: true, label: "evidence destination" });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`cannot atomically write evidence file ${destination}: ${error?.message ?? error}`);
  }
  return null;
}
function atomicWriteText(target, text3) {
  atomicWriteBytes2(target, Buffer.from(String(text3), "utf8"));
  return null;
}
function executeChecks(root, checks, logRoot) {
  const results = [];
  ensureDirectory(logRoot);
  for (const raw of checks) {
    const [checkId, argv, cwd, timeout, expected] = validateCheck(raw, root);
    const result = run(argv, cwd, timeout);
    const safe = checkId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
    const logPath = path10.join(String(logRoot), `${safe}.log`);
    atomicWriteText(
      logPath,
      `argv=${pyJsonDumps(argv)}
cwd=${cwd}
exit_code=${result.exit_code === null ? "None" : result.exit_code}
timed_out=${String(result.timed_out).toLowerCase()}

[stdout]
${result.stdout}
[stderr]
${result.stderr}`
    );
    const passed = expected.includes(result.exit_code) && !result.timed_out;
    const outputTail = checkOutputSummary(String(result.stdout || ""), String(result.stderr || ""));
    let visibleLog;
    try {
      visibleLog = pyRelativeToPosix(logPath, ROOT);
    } catch {
      visibleLog = String(logPath);
    }
    const checkResult = {
      id: checkId,
      argv,
      cwd: String(cwd),
      exit_code: result.exit_code,
      passed,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      output_tail: outputTail,
      log_path: visibleLog
    };
    if (!(expected.length === 1 && expected[0] === 0)) checkResult.expected_exit_codes = expected;
    results.push(checkResult);
  }
  return results;
}
function projectedSemanticTokens(enumeratedBytes, enumeratedFiles) {
  const overhead = enumeratedFiles * 96 + 1024;
  return Math.floor((enumeratedBytes + overhead + 2) / 3);
}
function semanticIndexComplete(scan) {
  return scan.mode !== "bounded_index" && scan.enumerationComplete && scan.omittedFileCount === 0;
}
function semanticMaterialOmissions(scan) {
  return {
    index_complete: semanticIndexComplete(scan),
    omitted_file_count: scan.omittedFileCount,
    unenumerated_directories: scan.unenumeratedDirectories,
    unenumerated_directory_overflow: scan.unenumeratedDirectoryOverflow,
    target_content_omitted: scan.targetContentOmitted,
    scope_read_directories: scan.scopeReadDirectories ?? [],
    read_authorization: "unchanged",
    note: "\u7701\u7565\u6216\u672A\u679A\u4E3E\u8DEF\u5F84\u672A\u88AB\u9884\u88C5\uFF0C\u4E0D\u8868\u793A scope.read \u88AB\u53D6\u6D88\uFF1B\u540E\u7EED\u4ECD\u53EF\u6309\u539F\u6388\u6743\u8BFB\u53D6\u3002\u4EC5\u7531 scope.read \u6388\u6743\u7684\u76EE\u5F55\u4E0D\u81EA\u52A8\u9884\u88C5\u6B63\u6587\uFF1B\u663E\u5F0F\u76EE\u6807\u4ECD\u6309\u9884\u7B97\u9001\u8FBE\u3002"
  };
}
function shrinkSemanticIndex(evidence, scan) {
  const targets = [];
  const rest = [];
  for (const item of evidence.sources) {
    if (item.declared_as?.includes("target")) targets.push(item);
    else rest.push(item);
  }
  evidence.sources = targets.concat(rest);
  while (rest.length && estimatedTokens(evidence) > SEMANTIC_INJECTION_TOKEN_LIMIT) {
    rest.pop();
    evidence.sources = targets.concat(rest);
    scan.omittedFileCount += 1;
  }
  if (estimatedTokens(evidence) > SEMANTIC_INJECTION_TOKEN_LIMIT) {
    for (const item of targets) {
      if (!Object.hasOwn(item, "content")) continue;
      delete item.content;
      if (!scan.targetContentOmitted.includes(item.path)) scan.targetContentOmitted.push(item.path);
    }
  }
}
function applySemanticMaterialMode(evidence, scan) {
  if (!scan) throw new ToolError("semantic evidence scan missing");
  evidence.material_mode = scan.mode === "full_candidate" ? "full" : "index";
  const estimatedFull = scan.mode === "full_candidate" ? estimatedTokens(evidence) : projectedSemanticTokens(scan.enumeratedBytes, scan.enumeratedFiles);
  if (scan.mode === "full_candidate" && estimatedFull > SEMANTIC_INJECTION_TOKEN_LIMIT) {
    evidence.material_mode = "index";
    let remaining = SEMANTIC_TARGET_CONTENT_BYTE_BUDGET;
    for (const item of evidence.sources) {
      const isTarget = Array.isArray(item.declared_as) && item.declared_as.includes("target");
      if (!isTarget || !Object.hasOwn(item, "content")) {
        delete item.content;
        continue;
      }
      const bytes = Buffer.byteLength(String(item.content), "utf8");
      if (bytes <= remaining) {
        remaining -= bytes;
        continue;
      }
      delete item.content;
      if (!scan.targetContentOmitted.includes(item.path)) scan.targetContentOmitted.push(item.path);
    }
  }
  if (evidence.material_mode === "index") {
    evidence.material_omissions = semanticMaterialOmissions(scan);
    if (estimatedTokens(evidence) > SEMANTIC_INJECTION_TOKEN_LIMIT) {
      shrinkSemanticIndex(evidence, scan);
      evidence.material_omissions = semanticMaterialOmissions(scan);
    }
  }
  evidence.material_stats = {
    token_limit: SEMANTIC_INJECTION_TOKEN_LIMIT,
    estimated_full_tokens: estimatedFull,
    injected_tokens: estimatedTokens(evidence),
    source_count: evidence.sources.length,
    full_content_source_count: evidence.sources.filter((item) => Object.hasOwn(item, "content")).length,
    index_complete: semanticIndexComplete(scan),
    omitted_file_count: scan.omittedFileCount,
    enumerated_file_count: scan.enumeratedFiles,
    enumerated_bytes: scan.enumeratedBytes,
    content_bytes_read: scan.contentBytesRead,
    unenumerated_directory_count: scan.unenumeratedDirectories.length + scan.unenumeratedDirectoryOverflow,
    scope_read_directory_count: (scan.scopeReadDirectories ?? []).length,
    budget_applied_before_read: true
  };
}
function buildEvidence(pkg2, options = {}) {
  const { execute, root = null, logRoot = null, outputRoot = null, outputPath = null } = options;
  const rid = routeId(pkg2);
  const contract = capabilityContract(pkg2, rid);
  const scope = isRecord(pkg2?.scope) ? pkg2.scope : {};
  const scopeRead = Array.isArray(scope.read) ? uniqueStrings(scope.read) : [];
  const base = resolveLikePython(root || reviewRoot(pkg2));
  const targets = declaredTargets(contract);
  const semanticReview = SEMANTIC_REVIEW_ROUTES.has(rid);
  let sources;
  let errors;
  let sourcesComplete;
  let semanticScan = null;
  if (semanticReview) {
    semanticScanSlot = null;
    [sources, errors, sourcesComplete] = semanticSourceEvidence(base, contract, scopeRead);
    semanticScan = semanticScanSlot;
    semanticScanSlot = null;
  } else {
    [sources, errors, sourcesComplete] = sourceEvidence(base, rid, contract, scopeRead, 6e4);
  }
  const rawChecks = Object.hasOwn(contract, "mechanical_checks") ? contract.mechanical_checks : [];
  if (!Array.isArray(rawChecks)) throw new ToolError("contract.mechanical_checks must be a list");
  let checks = [];
  if (execute) {
    let logs = logRoot;
    if (logs === null || logs === void 0) {
      logs = evidenceLogDirectory(evidenceOutputPath(pkg2, { outputRoot, outputPath }));
    }
    checks = executeChecks(base, rawChecks, logs);
  }
  const codeReady = rid !== "verify-agent__code-verification" || rawChecks.length > 0;
  const changeBase = typeof contract.change_base === "string" && contract.change_base.trim() ? contract.change_base.trim() : null;
  const gitEvidence = scopedGitEvidence(
    base,
    uniqueStrings([...targets, ...scopeRead]),
    rid === "verify-agent__code-verification" ? 0 : 1e3,
    changeBase
  );
  if (gitEvidence.mode === "invalid_base") errors.push(`change_base does not resolve to a commit: ${changeBase}`);
  const complete = Boolean(execute && sourcesComplete && codeReady && !errors.length);
  const closedDossier = Array.isArray(pkg2?.tool_contract?.allowed) && pkg2.tool_contract.allowed.length === 0;
  const omittedContractKeys = /* @__PURE__ */ new Set(["mechanical_checks", "output_report"]);
  if (rid === "verify-agent__code-verification") omittedContractKeys.add("affected_files");
  const reviewContract = Object.fromEntries(
    Object.entries(contract).filter(([key]) => !omittedContractKeys.has(key))
  );
  const evidence = {
    schema_version: 1,
    route_id: rid,
    profile: semanticReview ? SEMANTIC_PROFILE : closedDossier && complete && !truthyText(pkg2?.runtime_context?.network_needed) ? PROFILE : ASSISTED_PROFILE,
    complete,
    goal: pkg2?.goal ?? null,
    contract: reviewContract,
    known_facts: Object.hasOwn(pkg2, "known_facts") ? pkg2.known_facts : [],
    git: gitEvidence,
    sources,
    mechanical_checks: checks,
    errors
  };
  if (semanticReview) {
    evidence.source_root = String(base);
    applySemanticMaterialMode(evidence, semanticScan);
  }
  return evidence;
}
function writeEvidenceFile(output, evidence) {
  const payload = Buffer.from(`${pyJsonDumps(evidence, { compact: true })}
`, "utf8");
  atomicWriteBytes2(output, payload);
  return null;
}
function derivedEvidenceFilename(packageId2) {
  const raw = String(packageId2 || "package");
  let safe = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^\.+/, "").replace(/\.+$/, "").slice(0, 80);
  if (!safe) safe = "package";
  if (safe !== raw || [".", ".."].includes(raw)) safe = `${safe}-${ids.uuidHex().slice(0, 16)}`;
  return `${safe}.json`;
}
function assertDerivedOutputContained(output, root) {
  const rootPath = lexicalAbsolute(root);
  const outputPath = lexicalAbsolute(output);
  assertNoReparse(rootPath, { allowMissing: true });
  assertNoReparse(outputPath, { allowMissing: true });
  if (!pyIsRelativeTo(resolveLikePython(outputPath), resolveLikePython(rootPath))) {
    throw new ToolError(`derived evidence output escapes output root: ${outputPath}`);
  }
  return outputPath;
}
function evidenceLogDirectory(output) {
  const target = lexicalAbsolute(output);
  const parsed = path10.parse(target);
  const stripped = parsed.ext ? path10.join(parsed.dir, parsed.name) : target;
  return stripped !== target ? stripped : path10.join(parsed.dir, `${parsed.base}.logs`);
}
function evidenceOutputPath(pkg2, options = {}) {
  const { outputRoot = null, outputPath = null } = options;
  const packageId2 = String(pkg2?.package_id || "package");
  if (outputPath !== null && outputPath !== void 0) {
    return lexicalAbsolute(outputPath);
  }
  if (outputRoot !== null && outputRoot !== void 0) {
    const root2 = lexicalAbsolute(outputRoot);
    if (path10.extname(root2).toLowerCase() === ".json" || Boolean(statOrNull2(root2)?.isFile())) return root2;
    return assertDerivedOutputContained(path10.join(root2, derivedEvidenceFilename(packageId2)), root2);
  }
  const root = lexicalAbsolute(path10.join(ROOT, "tmp", "review_evidence"));
  return assertDerivedOutputContained(path10.join(root, derivedEvidenceFilename(packageId2)), root);
}
function attachReviewEvidence(envelope, options = {}) {
  const { execute, root = null, outputRoot = null, outputPath = null } = options;
  const pkg2 = isRecord(envelope?.task_package) ? envelope.task_package : envelope;
  if (!isRecord(pkg2) || !isStaticReview(pkg2)) return null;
  const output = evidenceOutputPath(pkg2, { outputRoot, outputPath });
  const evidence = buildEvidence(pkg2, {
    execute,
    root,
    logRoot: evidenceLogDirectory(output),
    outputRoot,
    outputPath
  });
  const sourceCount = evidence.sources.length;
  const checkCount = evidence.mechanical_checks.length;
  const checkFailures = evidence.mechanical_checks.filter((item) => !item.passed).length;
  if (!Object.hasOwn(pkg2, "extensions")) pkg2.extensions = {};
  const extensions = pkg2.extensions;
  if (!isRecord(extensions)) throw new ToolError("task_package.extensions must be an object");
  let evidenceRef;
  if (execute) {
    writeEvidenceFile(output, evidence);
    evidenceRef = {
      schema_version: 1,
      profile: evidence.profile,
      complete: evidence.complete,
      path: pyIsRelativeTo(output, ROOT) ? pyRelativeToPosix(output, ROOT) : String(output),
      source_count: sourceCount,
      check_count: checkCount,
      check_failures: checkFailures
    };
    if (evidence.profile === SEMANTIC_PROFILE) {
      evidenceRef.material_mode = evidence.material_mode;
      evidenceRef.material_stats = evidence.material_stats;
    }
  } else {
    evidenceRef = {
      schema_version: 1,
      profile: evidence.profile === SEMANTIC_PROFILE ? SEMANTIC_PROFILE : truthyText(pkg2?.runtime_context?.network_needed) ? ASSISTED_PROFILE : "preview",
      complete: false,
      path: null,
      source_count: sourceCount,
      check_count: 0,
      check_failures: 0
    };
    if (evidence.profile === SEMANTIC_PROFILE) {
      evidenceRef.material_mode = evidence.material_mode;
      evidenceRef.material_stats = evidence.material_stats;
    }
  }
  extensions.review_execution = {
    profile: evidenceRef.profile,
    result_schema: "review_result_v1",
    artifact_writer: "async child runner",
    contract_slot: CONTRACT_SLOTS[routeId(pkg2)]
  };
  if (evidenceRef.profile === SEMANTIC_PROFILE) extensions.review_execution.material_mode = evidenceRef.material_mode;
  extensions.review_evidence = evidenceRef;
  return evidenceRef;
}
var PROFILE, ASSISTED_PROFILE, SEMANTIC_PROFILE, SEMANTIC_INJECTION_TOKEN_LIMIT, SEMANTIC_FULL_CONTENT_BYTE_CEILING, SEMANTIC_COMPLETE_INDEX_FILE_CAP, SEMANTIC_TARGET_CONTENT_BYTE_BUDGET, SEMANTIC_OMISSION_DIR_CAP, REGENERATED_TREE_REASONS, semanticScanSlot, REVIEW_ROUTES, SEMANTIC_REVIEW_ROUTES, STATIC_REVIEW_ROUTES, CONTRACT_SLOTS, TARGET_KEYS, TOKEN_RE, SURFACE_RANGE_RE, SURFACE_RANGE_MAX_LINES;
var init_review_evidence = __esm({
  "ops/tools/dispatch-core/review_evidence.mjs"() {
    init_tool_common();
    init_py();
    init_task_package_build();
    PROFILE = "evidence_only_v1";
    ASSISTED_PROFILE = "evidence_assisted_v1";
    SEMANTIC_PROFILE = "semantic_review_v2";
    SEMANTIC_INJECTION_TOKEN_LIMIT = 2e5;
    SEMANTIC_FULL_CONTENT_BYTE_CEILING = SEMANTIC_INJECTION_TOKEN_LIMIT * 3;
    SEMANTIC_COMPLETE_INDEX_FILE_CAP = 2048;
    SEMANTIC_TARGET_CONTENT_BYTE_BUDGET = 6e4;
    SEMANTIC_OMISSION_DIR_CAP = 32;
    REGENERATED_TREE_REASONS = /* @__PURE__ */ new Map([
      [".git", "vcs_metadata"],
      [".runtime", "regenerated_runtime"],
      ["node_modules", "dependency_tree"]
    ]);
    semanticScanSlot = null;
    REVIEW_ROUTES = {
      "verify-agent__code-verification": { kind: "evidence", contract_slot: "verify" },
      "verify-agent__anti-defensive-inspection": { kind: "evidence", contract_slot: "anti_defensive_inspection" },
      "verify-agent__prompt-bloat-inspection": { kind: "evidence", contract_slot: "prompt_bloat_inspection" },
      "semantic-review-agent__rule-quality-inspection": { kind: "semantic", contract_slot: "rule_quality_inspection" },
      "semantic-review-agent__contract-drift-inspection": { kind: "semantic", contract_slot: "contract_drift_inspection" }
    };
    SEMANTIC_REVIEW_ROUTES = new Set(
      Object.entries(REVIEW_ROUTES).filter(([, spec]) => spec.kind === "semantic").map(([rid]) => rid)
    );
    STATIC_REVIEW_ROUTES = new Set(Object.keys(REVIEW_ROUTES));
    CONTRACT_SLOTS = Object.fromEntries(
      Object.entries(REVIEW_ROUTES).map(([rid, spec]) => [rid, spec.contract_slot])
    );
    assertReviewRoutesConsistent();
    TARGET_KEYS = ["target_files", "affected_files", "truth_sources", "downstream_truth_sources"];
    TOKEN_RE = /[A-Za-z_][A-Za-z0-9_.-]{2,}/g;
    SURFACE_RANGE_RE = /(?<![\p{L}\p{N}_.])(\d{1,6})\s*[-–]\s*(\d{1,6})(?![\p{L}\p{N}_.])/u;
    SURFACE_RANGE_MAX_LINES = 240;
  }
});

// ops/tools/dispatch-core/model_selection_guidance.mjs
var MODEL_SELECTION_GUIDANCE;
var init_model_selection_guidance = __esm({
  "ops/tools/dispatch-core/model_selection_guidance.mjs"() {
    MODEL_SELECTION_GUIDANCE = Object.freeze([
      "pick \u4E0E model \u81F3\u591A\u7ED9\u4E00\u4E2A\uFF0C\u90FD\u4E0D\u7ED9\u65F6\u7528\u672C\u4EFB\u52A1\u7C7B\u578B\u7684\u6709\u6548\u9ED8\u8BA4\u63A8\u8350\u884C\uFF1Beffort \u53EF\u663E\u5F0F\u7ED9\u51FA\u3002",
      "\u53EA\u7ED9 model \u65F6\u5148\u770B\u6709\u6548\u9ED8\u8BA4\u884C\uFF0C\u518D\u6309\u987A\u5E8F\u627E\u672C\u4EFB\u52A1\u7C7B\u578B\u9002\u7528\u7684\u540C\u6A21\u578B\u63A8\u8350\u884C\uFF0C\u6CBF\u7528\u8BE5\u884C\u6863\u4F4D\u4E0E\u8303\u56F4\uFF1B\u627E\u4E0D\u5230\u65F6\u5FC5\u987B\u663E\u5F0F\u7ED9\u51FA effort\u3002",
      "effort \u5FC5\u987B\u5728\u6A21\u578B\u53EF\u9009\u6863\u4F4D\u5185\uFF0C\u6388\u6743\u4E0D\u80FD\u89E3\u9664\u3002\u8D8A\u51FA\u6240\u5728\u884C [min\u2013max] \u9700\u6388\u6743 effort_range\uFF0C\u6A21\u578B\u4E0D\u5728\u672C\u89D2\u8272\u4EFB\u4F55\u63A8\u8350\u884C\u91CC\u9700\u6388\u6743 outside_pool\uFF1Aauthorization={quote: \u7528\u6237\u672C\u8F6E\u539F\u8BDD, overrides: [...]}\uFF0C\u53EA\u5BF9\u672C\u6B21 model + effort \u751F\u6548\u3002"
    ]);
  }
});

// ops/tools/dispatch-core/seed_minimal.mjs
import path11 from "node:path";
function deepCopy(value) {
  return structuredClone(value);
}
function setDefaultDict(container, key) {
  if (!Object.hasOwn(container, key)) container[key] = {};
  return container[key];
}
function isEmptyMapping(value) {
  return isRecord(value) && Object.keys(value).length === 0;
}
function templateSchema(name) {
  const file = path11.join(RUNTIME_ROOT, "ops", "templates", name);
  if (!schemaCache.has(file)) schemaCache.set(file, JSON.parse(pyReadText(file)));
  return schemaCache.get(file);
}
function sortedCopy(values) {
  return [...values].sort();
}
function planningSchemaSnapshot() {
  const schema = templateSchema("planning-schema.json");
  return {
    source: "ops/tools/planning_manifest_check.py",
    planning_pass_values: sortedCopy(schema.planning_passes),
    interface_contract_kind_values: sortedCopy(schema.contract_kinds),
    interface_contract_stability_values: sortedCopy(schema.contract_stability),
    serial_reason_values: sortedCopy(schema.serial_reasons),
    dispatch_mode_values: sortedCopy(schema.dispatch_modes),
    release_gate_values: sortedCopy(schema.release_gates),
    dependency_type_values: sortedCopy(schema.dependency_types)
  };
}
function routeContractRequirements() {
  const result = {};
  for (const routeId2 of templateSchema("acceptance-schema.json").validation_routes) {
    const card = pyGet(profileFor(routeId2), "card");
    if (!isRecord(card)) throw new ToolError(`validation route has no route_card: ${routeId2}`);
    const paths = [];
    for (const item of pyGet(card, "required", [])) {
      if (!isRecord(item)) continue;
      const itemPath = pyGet(item, "path");
      if (typeof itemPath !== "string" || !itemPath.startsWith("contract.")) continue;
      paths.push(itemPath.slice("contract.".length));
    }
    result[routeId2] = paths.sort();
  }
  return result;
}
function acceptanceSchemaSnapshot() {
  const schema = templateSchema("acceptance-schema.json");
  return {
    source: "ops/tools/acceptance_contract_check.py",
    schema_version: schema.schema_version,
    technique_values: sortedCopy(schema.techniques),
    case_kind_values: sortedCopy(schema.case_kinds),
    severity_values: sortedCopy(schema.severity_values),
    validation_route_values: [...schema.validation_routes],
    entry_route_values: [...schema.entry_routes],
    route_contract_requirements: routeContractRequirements(),
    route_contract_macros: sortedCopy(schema.macros),
    disposition_values: sortedCopy(schema.dispositions),
    max_review_rounds: schema.max_review_rounds
  };
}
function validatePlannerMechanicalSchema(schema) {
  const problems = [];
  if (pyGet(schema, "source") !== "ops/tools/planning_manifest_check.py") problems.push("source");
  for (const key of PLANNER_SCHEMA_LIST_KEYS) {
    const value = pyGet(schema, key);
    if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item)) {
      problems.push(key);
    }
  }
  if (problems.length) {
    throw new ToolError(
      `planner mechanical_schema unavailable or incomplete: ${problems.join(", ")}; stop before task material write and repair planning_manifest_check.py schema export`
    );
  }
  return null;
}
function injectPlannerMechanicalSchema(seed) {
  if (pyGet(seed, "route_id") !== "planner-agent__plan-authoring") return seed;
  const schema = planningSchemaSnapshot();
  validatePlannerMechanicalSchema(schema);
  const planner = setDefaultDict(setDefaultDict(setDefaultDict(seed, "extensions"), "capability_contract"), "planner");
  planner.mechanical_schema = schema;
  return seed;
}
function injectAcceptanceMechanicalContract(seed) {
  const routeId2 = pyGet(seed, "route_id");
  if (routeId2 !== "planner-agent__acceptance-authoring" && routeId2 !== "verify-agent__acceptance-synthesis") {
    return seed;
  }
  const schema = acceptanceSchemaSnapshot();
  const required = [
    "technique_values",
    "case_kind_values",
    "severity_values",
    "validation_route_values",
    "route_contract_macros",
    "disposition_values"
  ];
  const problems = required.filter((key) => {
    const value = pyGet(schema, key);
    return !Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item);
  });
  if (pyGet(schema, "source") !== "ops/tools/acceptance_contract_check.py") problems.push("source");
  if (!isRecord(pyGet(schema, "route_contract_requirements"))) problems.push("route_contract_requirements");
  const maxReviewRounds = pyGet(schema, "max_review_rounds");
  if (typeof maxReviewRounds !== "number" || !Number.isInteger(maxReviewRounds) || maxReviewRounds < 1) {
    problems.push("max_review_rounds");
  }
  if (problems.length) {
    throw new ToolError(
      `acceptance mechanical schema unavailable or incomplete: ${sortedCopy(new Set(problems)).join(", ")}; stop before task material write and repair acceptance_contract_check.py`
    );
  }
  const contracts = setDefaultDict(setDefaultDict(seed, "extensions"), "capability_contract");
  if (routeId2 === "planner-agent__acceptance-authoring") {
    setDefaultDict(contracts, "acceptance_authoring").mechanical_schema = schema;
  } else {
    const synthesis = setDefaultDict(contracts, "acceptance_synthesis");
    synthesis.max_review_rounds = schema.max_review_rounds;
    synthesis.mechanical_schema = {
      source: schema.source,
      disposition_values: schema.disposition_values,
      max_review_rounds: schema.max_review_rounds
    };
  }
  return seed;
}
function routesWithCards() {
  const profiles = routeProfiles();
  return Object.entries(profiles).filter(([, profile]) => pyTruthy(pyGet(profile, "card"))).map(([routeId2]) => routeId2).sort();
}
function setPath(data, dotted, value) {
  let cursor = data;
  const keys = String(dotted).split(".");
  for (const key of keys.slice(0, -1)) cursor = setDefaultDict(cursor, key);
  cursor[keys[keys.length - 1]] = deepCopy(value);
  return null;
}
function getPath(data, dotted) {
  let cursor = data;
  for (const part of String(dotted).split(".")) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, part)) return null;
    cursor = cursor[part];
  }
  return cursor;
}
function alignExpectedOutputWrite(full, reportPath, writeExtra) {
  const expected = pyGet(full, "expected_output");
  const scope = pyGet(full, "scope");
  const concurrency = pyGet(full, "concurrency_contract");
  if (!isRecord(expected) || !isRecord(scope)) return null;
  const filePath = pyGet(expected, "file_path");
  let writes = pyGet(scope, "write");
  if (typeof filePath !== "string" || !filePath.trim() || !Array.isArray(writes)) return null;
  if (!writes.includes(filePath)) writes.unshift(filePath);
  const writeExtraSet = new Set(writeExtra);
  if (filePath !== reportPath && writes.includes(reportPath) && !writeExtraSet.has(reportPath)) {
    scope.write = writes.filter((item) => item !== reportPath);
    writes = scope.write;
  }
  if (isRecord(concurrency)) {
    const conflict = pyGet(concurrency, "conflict_keys");
    if (isRecord(conflict)) {
      conflict.write = [...writes];
      conflict.output = filePath;
    }
  }
  return null;
}
function alignHandoffOutputWrite(full, defaultHandoffPath, writeExtra) {
  const handoff = pyGet(full, "handoff_contract");
  const scope = pyGet(full, "scope");
  const concurrency = pyGet(full, "concurrency_contract");
  if (!isRecord(handoff) || !isRecord(scope)) return null;
  const resolvedOverride = pyGet(handoff, "resolved_handoff_file");
  if (typeof resolvedOverride === "string" && resolvedOverride.trim()) handoff.handoff_file = resolvedOverride;
  const handoffFile = pyGet(handoff, "handoff_file");
  let writes = pyGet(scope, "write");
  if (typeof handoffFile !== "string" || !handoffFile.trim() || !Array.isArray(writes)) return null;
  if (!writes.includes(handoffFile)) writes.push(handoffFile);
  if (handoffFile !== defaultHandoffPath && writes.includes(defaultHandoffPath) && !new Set(writeExtra).has(defaultHandoffPath)) {
    scope.write = writes.filter((item) => item !== defaultHandoffPath);
    writes = scope.write;
  }
  if (isRecord(concurrency)) {
    const conflict = pyGet(concurrency, "conflict_keys");
    if (isRecord(conflict)) conflict.write = [...writes];
  }
  return null;
}
function applyDelegationIntent(full, seed) {
  const intent = stripPlaceholders(pyGet(seed, "delegation_intent"));
  if (typeof intent !== "string" || !intent.trim()) return null;
  setDefaultDict(setDefaultDict(full, "extensions"), "orchestration").delegation_intent = intent.trim();
  return null;
}
function isPlaceholder(value) {
  return typeof value === "string" && PLACEHOLDER_RE.test(value.trim());
}
function valueMissing(value) {
  if (value === null || value === void 0) return true;
  if (isPlaceholder(value)) return true;
  if (typeof value === "string" && !value.trim()) return true;
  if (Array.isArray(value)) return !value.length || value.some(isPlaceholder);
  return false;
}
function stripPlaceholders(value) {
  if (isRecord(value)) {
    const cleaned = {};
    for (const [key, item] of Object.entries(value)) {
      if (isPlaceholder(item)) continue;
      cleaned[key] = stripPlaceholders(item);
    }
    const out = {};
    for (const [key, item] of Object.entries(cleaned)) {
      if (item === null || item === void 0) continue;
      out[key] = item;
    }
    return out;
  }
  if (Array.isArray(value)) return value.filter((item) => !isPlaceholder(item)).map(stripPlaceholders);
  if (isPlaceholder(value)) return null;
  return value === void 0 ? null : value;
}
function listSeedValues(value) {
  if (valueMissing(value)) return [];
  if (Array.isArray(value)) return value.filter((item) => !isPlaceholder(item)).map(pyStr);
  return [pyStr(value)];
}
function deepMerge(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (isRecord(value) && isRecord(pyGet(base, key))) deepMerge(base[key], value);
    else base[key] = deepCopy(value);
  }
  return base;
}
function resolveVars(value, ctx) {
  if (typeof value === "string" && value.startsWith("$")) {
    const key = value.slice(1);
    if (key.startsWith("contract.")) {
      const contract = pyOr(pyGet(ctx, "contract"), {});
      const inner = pyGet(contract, key.slice(key.indexOf(".") + 1));
      if (inner === null || inner === void 0) throw new ToolError(`route_card default references unset ${value}`);
      return deepCopy(inner);
    }
    if (isRecord(ctx) && Object.hasOwn(ctx, key)) return deepCopy(ctx[key]);
    throw new ToolError(`route_card default references unknown variable ${value}`);
  }
  if (Array.isArray(value)) return value.map((item) => resolveVars(item, ctx));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveVars(item, ctx)]));
  }
  return value;
}
function autoSlug(routeId2, goal) {
  const parts = String(routeId2).split("__");
  if (parts.length < 2) throw pyError("IndexError", "list index out of range");
  const capability = parts.slice(1).join("__");
  const stamp = utcDateStamp();
  return `${capability}-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}
function applyInputDefaults(seed, card) {
  const normalized = deepCopy(seed);
  for (const [key, value] of Object.entries(card.input_defaults ?? {})) {
    const parts = key.split(".");
    const parent = parts.slice(0, -1).reduce((node, part) => node?.[part], normalized);
    const current = parent?.[parts.at(-1)];
    const placeholder = isPlaceholder(current) || Array.isArray(current) && current.length > 0 && current.every(isPlaceholder);
    if (parent && Object.hasOwn(parent, parts.at(-1)) && !placeholder) continue;
    setPath(normalized, key, resolveVars(value, {
      goal: normalized.goal,
      scope_read: normalized.scope?.read ?? null
    }));
  }
  return normalized;
}
function checkRequired(seed, card, routeId2) {
  const problems = [];
  const derived = pyGet(card, "optional", []).filter((item) => Object.hasOwn(card.input_defaults ?? {}, item.path));
  for (const req of [...pyGet(card, "required", []), ...derived]) {
    if (["contract.planning_pass", "contract.review_round", "contract.surface_rounds"].includes(req.path)) continue;
    const condition = pyGet(req, "required_when");
    if (condition !== null && condition !== void 0) {
      const keys = isRecord(condition) ? Object.keys(condition).sort() : null;
      if (!keys || keys.length !== 2 || keys[0] !== "equals" || keys[1] !== "path") {
        throw new ToolError(`route ${routeId2} required_when must contain only path and equals`);
      }
      const conditionPath = pyGet(condition, "path");
      if (typeof conditionPath !== "string" || !conditionPath.trim()) {
        throw new ToolError(`route ${routeId2} required_when.path must be a non-empty string`);
      }
      if (getPath(seed, conditionPath) !== pyGet(condition, "equals", null)) continue;
    }
    const reqPath = pyGetItem(req, "path");
    const value = getPath(seed, reqPath);
    const hint = pyGet(req, "hint", "");
    const example = pyGet(req, "example", null);
    if (valueMissing(value) && !(pyGet(req, "allow_empty") === true && Array.isArray(value) && !value.length)) {
      let line = `\u7F3A ${reqPath}`;
      if (pyTruthy(hint)) line += `\uFF1A${hint}`;
      if (pyTruthy(pyGet(req, "enum"))) line += `\uFF1B\u53EA\u80FD\u53D6 ${pyGetItem(req, "enum").join(" | ")}`;
      if (example !== null && example !== void 0 && !(typeof example === "string" && example.startsWith("$"))) {
        line += `\uFF1B\u793A\u4F8B: ${pyJsonDumps(example)}`;
      }
      problems.push(line);
      continue;
    }
    const enumValues = pyGet(req, "enum");
    if (pyTruthy(enumValues) && !enumValues.includes(value)) {
      problems.push(`${reqPath} \u53D6\u503C\u975E\u6CD5\uFF1A\u53EA\u80FD\u53D6 ${enumValues.join(" | ")}\uFF0C\u6536\u5230 ${pyJsonDumps(value)}`);
    }
  }
  if (problems.length) {
    throw new ToolError(
      `minimal seed \u4E0D\u5B8C\u6574\uFF0C\u9010\u9879\u8865\u9F50\u540E\u91CD\u8BD5\uFF1A
- ${problems.join("\n- ")}
\u9AA8\u67B6\u53C2\u8003: node ops/tools/dispatch_prepare.mjs --seed-template ${routeId2}`
    );
  }
  return null;
}
function genericSeed(routeId2, pkgId, goal, scope, reportPath, handoffPath) {
  return {
    route_id: routeId2,
    package_id: pkgId,
    goal,
    project_positioning: {
      project: readProjectName(),
      status: "\u89C1 STATUS.md",
      roadmap: "\u89C1 ROADMAP.md"
    },
    scope,
    ownership: {
      owner: "child_agent",
      parent_forbidden_same_scope_probe: true
    },
    concurrency_contract: {
      group_id: `dispatch-${routeId2}`,
      lane_id: pkgId,
      depends_on: [],
      conflict_keys: {
        read: [...pyGetItem(scope, "read")],
        write: [...pyGetItem(scope, "write")],
        delete: [],
        output: reportPath
      },
      parallel_policy: "allowed_if_no_conflict"
    },
    inputs: { question: goal },
    known_facts: [],
    expected_output: {
      mode: "file",
      file_path: reportPath
    },
    runtime_context: {
      network_needed: "no"
    },
    alignment: {
      alignment_state_ref: null,
      planner_allowed: false,
      guard_status: "not_applicable"
    },
    planning_policy: {
      plan_required: false,
      reason: "outside PLAN single dispatch"
    },
    tool_contract: {
      allowed: null,
      forbidden: [],
      network_allowed: false,
      install_allowed: false
    },
    stop_conditions: [
      "required input file missing",
      "scope authorization conflict",
      "output contract cannot be satisfied"
    ],
    extensions: {},
    handoff_contract: {
      handoff_file_required: true,
      handoff_file: handoffPath,
      accept_verdicts: ["done", "partial", "needs_owner", "failed"]
    }
  };
}
function expandSeed(seed) {
  const routeId2 = pyGet(seed, "route_id");
  if (typeof routeId2 !== "string" || !routeId2.trim()) {
    throw new ToolError("package_seed.route_id is required at the JSON root");
  }
  const profile = profileFor(routeId2);
  if ([...FULL_SEED_FIELDS].every((key) => isRecord(seed) && Object.hasOwn(seed, key))) {
    const fullSeed = injectPlannerMechanicalSchema(deepCopy(seed));
    return injectAcceptanceMechanicalContract(fullSeed);
  }
  const card = pyGet(profile, "card");
  if (card === null || card === void 0) {
    throw new ToolError(
      `route ${routeId2} \u6CA1\u6709\u5DEE\u5F02\u5361\uFF0C\u6700\u5C0F\u79CD\u5B50\u4E0D\u53EF\u7528\uFF1B\u6309 ${pyGetItem(profile, "route_file")} \u63D0\u4F9B\u5B8C\u6574 package_seed\uFF0C\u5DF2\u652F\u6301\u6700\u5C0F\u79CD\u5B50\u7684 route: ${pyOr(routesWithCards().join(", "), "(none)")}`
    );
  }
  seed = applyInputDefaults(seed, card);
  const scopeIn = pyOr(pyGet(seed, "scope"), {});
  if (Object.hasOwn(scopeIn, "write")) {
    scopeIn.write_extra = [.../* @__PURE__ */ new Set([
      ...listSeedValues(pyGet(scopeIn, "write_extra")),
      ...stringList(scopeIn.write, "scope.write")
    ])];
  }
  checkRequired(seed, card, routeId2);
  let goalValue = pyGet(seed, "goal");
  if (valueMissing(goalValue)) {
    const goalFrom = pyGet(card, "goal_from");
    let source = typeof goalFrom === "string" && goalFrom ? getPath(seed, goalFrom) : null;
    if (Array.isArray(source)) {
      source = source.find((item) => typeof item === "string" && item.trim()) ?? null;
    }
    if (valueMissing(source)) {
      throw new ToolError(
        `minimal seed \u7F3A goal\uFF0C\u4E14 route ${routeId2} \u65E0\u6CD5\u4ECE ${pyOr(goalFrom, "route card")} \u6D3E\u751F`
      );
    }
    goalValue = source;
  }
  const goal = pyStr(goalValue).trim();
  const scopeRead = pyGet(scopeIn, "read", []).map(pyStr);
  const slugValue = pyGet(seed, "slug");
  const slug = typeof slugValue === "string" && pyStr(slugValue).trim() && !isPlaceholder(slugValue) ? pyStr(slugValue).trim() : autoSlug(routeId2, goal);
  const pkgId = packageId(routeId2, seed);
  const reportDir = pyStripChars(pyStr(pyGet(card, "report_dir", "notes/general")), "/");
  const reportPath = `${reportDir}/${slug}.md`;
  const handoffPath = `notes/handoffs/${pkgId}.md`;
  const writeExtra = listSeedValues(pyGet(scopeIn, "write_extra"));
  const scope = {
    read: scopeRead,
    write: [reportPath, handoffPath, ...writeExtra],
    delete: listSeedValues(pyGet(scopeIn, "delete")),
    out_of_scope: listSeedValues(pyGet(scopeIn, "out_of_scope_extra"))
  };
  const contractIn = stripPlaceholders(pyOr(pyGet(seed, "contract"), {}));
  const ctx = {
    route_id: routeId2,
    goal,
    slug,
    scope_read: scopeRead,
    report_path: reportPath,
    handoff_path: handoffPath,
    contract: contractIn
  };
  const contract = resolveVars(pyGet(card, "contract_defaults", {}), ctx);
  deepMerge(contract, contractIn);
  for (const field of ["planning_pass", "review_round", "surface_rounds"]) {
    if (Object.hasOwn(seed.contract ?? {}, field)) contract[field] = deepCopy(seed.contract[field]);
  }
  ctx.contract = contract;
  const full = genericSeed(routeId2, pkgId, goal, scope, reportPath, handoffPath);
  deepMerge(full, resolveVars(pyGet(card, "seed_defaults", {}), ctx));
  for (const item of listSeedValues(pyGet(scopeIn, "out_of_scope_extra"))) {
    if (!full.scope.out_of_scope.includes(item)) full.scope.out_of_scope.push(item);
  }
  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  if (slot) {
    setDefaultDict(full.extensions, "capability_contract")[slot] = contract;
  } else if (pyTruthy(contract)) {
    throw new ToolError(
      `route ${routeId2} \u5DEE\u5F02\u5361\u672A\u58F0\u660E slot\uFF0C\u6700\u5C0F\u79CD\u5B50\u4E0D\u63A5\u53D7 contract \u5B57\u6BB5\uFF1B\u8BE5 route \u7684\u5408\u6CD5\u5B57\u6BB5\u9AA8\u67B6\u89C1 --seed-template ${routeId2}\uFF0C\u4EFB\u52A1\u7EC6\u8282\u6539\u653E goal / inputs.constraints / known_facts`
    );
  }
  applyDelegationIntent(full, seed);
  for (const [key, raw] of Object.entries(seed)) {
    if (MINIMAL_ONLY_KEYS.has(key) || ["route_id", "package_id", "goal", "scope"].includes(key)) continue;
    const value = stripPlaceholders(raw);
    if (value === null || isEmptyMapping(value) || Array.isArray(value) && !value.length) continue;
    if (isRecord(value) && isRecord(pyGet(full, key))) deepMerge(full[key], value);
    else full[key] = deepCopy(value);
  }
  injectPlannerMechanicalSchema(full);
  injectAcceptanceMechanicalContract(full);
  alignExpectedOutputWrite(full, reportPath, writeExtra);
  alignHandoffOutputWrite(full, handoffPath, writeExtra);
  return full;
}
var PLACEHOLDER_RE, FULL_SEED_FIELDS, MINIMAL_ONLY_KEYS, PLANNER_SCHEMA_LIST_KEYS, schemaCache;
var init_seed_minimal = __esm({
  "ops/tools/dispatch-core/seed_minimal.mjs"() {
    init_tool_common();
    init_py();
    init_task_package_profiles();
    init_task_package_build();
    init_model_selection_guidance();
    init_model_selection();
    PLACEHOLDER_RE = /^<[\s\S]*>\n?$/;
    FULL_SEED_FIELDS = new Set(SEED_BODY_REQUIRED);
    MINIMAL_ONLY_KEYS = /* @__PURE__ */ new Set(["contract", "slug", "delegation_intent"]);
    PLANNER_SCHEMA_LIST_KEYS = [
      "planning_pass_values",
      "interface_contract_kind_values",
      "interface_contract_stability_values",
      "serial_reason_values",
      "dispatch_mode_values",
      "release_gate_values",
      "dependency_type_values"
    ];
    schemaCache = /* @__PURE__ */ new Map();
  }
});

// ops/tools/dispatch-core/subagent_preload.mjs
var REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET;
var init_subagent_preload = __esm({
  "ops/tools/dispatch-core/subagent_preload.mjs"() {
    init_tool_common();
    init_py();
    REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET = 2e5 * 4;
  }
});

// ops/tools/dispatch-core/task_package_lint.mjs
var init_task_package_lint = __esm({
  "ops/tools/dispatch-core/task_package_lint.mjs"() {
    init_tool_common();
    init_py();
    init_task_package_build();
    init_task_package_profiles();
  }
});

// ops/tools/pi_model_extension_profile.mjs
import { existsSync as existsSync6 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path12 from "node:path";
function resolvePiAgentDir(env = process.env) {
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  return path12.resolve(configured || path12.join(homedir2(), ".pi", "agent"));
}
function resolvePiChildModelExtensions(options = {}) {
  const env = options.env || process.env;
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync6;
  const agentDir = path12.resolve(options.agentDir || resolvePiAgentDir(env));
  return RELATIVE_EXTENSION_PATHS.map((relativePath) => path12.join(agentDir, ...relativePath.split("/"))).filter((candidate) => exists(candidate));
}
function isPiModelExtensionProfileCli(argv1 = process.argv[1]) {
  return path12.basename(String(argv1 || "")).toLowerCase() === "pi_model_extension_profile.mjs";
}
var PI_CHILD_MODEL_EXTENSION_PROFILE, RELATIVE_EXTENSION_PATHS;
var init_pi_model_extension_profile = __esm({
  "ops/tools/pi_model_extension_profile.mjs"() {
    PI_CHILD_MODEL_EXTENSION_PROFILE = "pi-child-model-extensions/v1";
    RELATIVE_EXTENSION_PATHS = Object.freeze([
      "extensions/openai-codex-sol-context-alias.ts",
      "npm/node_modules/pi-claude-code-provider/extensions/pi-claude-code-provider.ts",
      "npm/node_modules/@tian.zuo/pi-antigravity/index.ts"
    ]);
    if (isPiModelExtensionProfileCli()) {
      if (process.argv.slice(2).some((arg) => arg !== "--json")) {
        process.stderr.write("Usage: node ops/tools/pi_model_extension_profile.mjs [--json]\n");
        process.exit(2);
      }
      process.stdout.write(`${JSON.stringify({
        profile: PI_CHILD_MODEL_EXTENSION_PROFILE,
        extensions: resolvePiChildModelExtensions()
      })}
`);
    }
  }
});

// ops/tools/pi_worker_resources.mjs
import { spawn } from "node:child_process";
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readFileSync as readFileSync8, statSync as statSync8, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import path13 from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL } from "node:url";
function configError(code, file, field, message) {
  return Object.assign(new Error(`${file} ${field}\uFF1A${message}`), { code, file, field });
}
function literalLength(key) {
  return key.replaceAll("*", "").length;
}
function matches(value, pattern) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
function packageJsonName(dir) {
  const file = path13.join(dir, "package.json");
  if (!existsSync7(file)) return null;
  const name = JSON.parse(readFileSync8(file, "utf8")).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
function resourceName(file) {
  const parts = String(file).replaceAll("\\", "/").split("/").filter(Boolean);
  const last = parts.length - 1;
  if (parts[last] === "SKILL.md") return parts[last - 1];
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0 && modules < last) {
    return parts[modules + 1].startsWith("@") ? `${parts[modules + 1]}/${parts[modules + 2]}` : parts[modules + 1];
  }
  const local = parts.lastIndexOf("local-packages");
  if (local >= 0 && local < last) {
    const dir = parts.slice(0, local + 2).join("/");
    return packageJsonName(/^[A-Za-z]:$/.test(parts[0]) ? dir : `/${dir}`) ?? parts[local + 1];
  }
  const extensions = parts.lastIndexOf("extensions");
  if (extensions >= 0 && extensions === last - 1) return parts[last].replace(/\.[^.]+$/, "");
  if (extensions >= 0 && extensions < last) return parts[extensions + 1];
  return parts[last].replace(/\.[^.]+$/, "");
}
function loadWorkerResourcesConfig(configPath = WORKER_RESOURCES_CONFIG) {
  const raw = JSON.parse(readFileSync8(configPath, "utf8"));
  for (const [key, hint] of Object.entries(REMOVED_KEYS)) {
    if (raw[key] !== void 0) throw configError("field_removed", configPath, key, `\u5DF2\u5220\u9664\uFF0C${hint}`);
  }
  if (raw.version !== 2) throw configError("value_invalid", configPath, "version", "\u5FC5\u987B\u4E3A 2");
  const config = { configPath };
  for (const section of SECTIONS) {
    const entries = raw[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw configError("value_invalid", configPath, section, "\u5FC5\u987B\u5B58\u5728\u4E14\u662F\u5BF9\u8C61\uFF1B\u6CA1\u6709\u6761\u76EE\u65F6\u5199 {}");
    }
    for (const [key, entry] of Object.entries(entries)) {
      const field = `${section}.${key}`;
      if (section === "tools" && key.includes("*")) throw configError("value_invalid", configPath, field, "\u5DE5\u5177\u53EA\u5199\u5177\u4F53\u540D\u5B57\uFF0C\u4E0D\u652F\u6301 *");
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw configError("value_invalid", configPath, field, "\u5FC5\u987B\u662F\u5BF9\u8C61");
      const unknown = Object.keys(entry).find((item) => !ENTRY_KEYS[section].includes(item));
      if (unknown) throw configError("field_unknown", configPath, `${field}.${unknown}`, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${ENTRY_KEYS[section].join("\u3001")}`);
      if (!IMPORT_ACCESS.includes(entry.access)) throw configError("value_invalid", configPath, `${field}.access`, `\u5FC5\u987B\u662F ${IMPORT_ACCESS.join(" / ")} \u4E4B\u4E00`);
      for (const text3 of ["label", "group"]) {
        if (entry[text3] !== void 0 && typeof entry[text3] !== "string") throw configError("value_invalid", configPath, `${field}.${text3}`, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
      }
    }
    config[section] = entries;
  }
  const required = raw.required_tools;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !name.trim())) {
    throw configError("value_invalid", configPath, "required_tools", "\u5FC5\u987B\u662F\u5DE5\u5177\u540D\u6570\u7EC4");
  }
  for (const name of required) {
    if (config.tools[name]?.access === "off") throw configError("value_invalid", configPath, `tools.${name}.access`, "\u8FD0\u884C\u5FC5\u9700\u5DE5\u5177\u4E0D\u80FD\u8BBE\u4E3A off");
  }
  config.required_tools = [...required];
  return config;
}
function importEntry(config, section, name) {
  const hits = Object.keys(config[section]).filter((key) => matches(name, key));
  if (!hits.length) return null;
  const rank2 = (key) => key.includes("*") ? literalLength(key) : Number.POSITIVE_INFINITY;
  const best = Math.max(...hits.map(rank2));
  const top = hits.filter((key) => rank2(key) === best);
  if (top.length > 1) {
    throw configError("value_invalid", config.configPath, section, `${name} \u540C\u65F6\u5339\u914D ${top.join("\u3001")}\uFF1B\u5220\u53BB\u91CD\u590D\u6216\u5199\u51FA\u66F4\u5177\u4F53\u7684\u952E`);
  }
  return { key: top[0], ...config[section][top[0]] };
}
function accessOf(config, section, name) {
  if (section === "tools" && config.required_tools.includes(name)) return "default_on";
  return importEntry(config, section, name)?.access ?? "off";
}
async function discoverWorkerResources({
  cwd = process.cwd(),
  agentDir = process.env.PI_CODING_AGENT_DIR || path13.join(homedir3(), ".pi", "agent"),
  piCli = PI_CLI
} = {}) {
  const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL(path13.join(path13.dirname(piCli), "index.js")).href);
  const settingsPath = path13.join(agentDir, "settings.json");
  const settings = existsSync7(settingsPath) ? JSON.parse(readFileSync8(settingsPath, "utf8")) : {};
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory(settings) });
  const missing = [];
  const resolved = await manager.resolve(async (source) => {
    missing.push(source);
    return "skip";
  });
  const enabled = (type) => (resolved[type] || []).filter((item) => item.enabled && ["user", "project"].includes(item.metadata?.scope)).map((item) => ({ name: resourceName(item.path), path: item.path, scope: item.metadata.scope }));
  return { settingsPath, extensions: enabled("extensions"), skills: enabled("skills"), missing };
}
function probeRegisteredTools({ extensions, piCli = PI_CLI, cacheFile, cwd = process.cwd() }) {
  const key = JSON.stringify(["registration-only/v1", path13.resolve(cwd), ...[piCli, ...extensions.map((item) => item.path)].map((file) => [file, existsSync7(file) ? statSync8(file).mtimeMs : 0])]);
  const cached = existsSync7(cacheFile) ? JSON.parse(readFileSync8(cacheFile, "utf8")) : null;
  if (cached?.key === key) return Promise.resolve(cached.tools);
  const id = `${cacheFile}
${key}`;
  if (!probes.has(id)) {
    probes.set(id, runToolProbe(extensions, piCli, cwd).then((tools) => {
      mkdirSync6(path13.dirname(cacheFile), { recursive: true });
      writeFileSync4(cacheFile, JSON.stringify({ key, tools }));
      return tools;
    }).finally(() => probes.delete(id)));
  }
  return probes.get(id);
}
function runToolProbe(extensions, piCli, cwd) {
  const loader = path13.join(path13.dirname(piCli), "core", "extensions", "loader.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", PROBE_SCRIPT], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PI_TOOL_PROBE_LOADER: loader, PI_TOOL_PROBE_EXTENSIONS: JSON.stringify(extensions.map((item) => item.path)) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Pi \u6269\u5C55\u6CE8\u518C\u63A2\u6D4B\u5931\u8D25\uFF08exit ${code}\uFF09${stderr.trim() ? `\uFF1A${stderr.trim().slice(-400)}` : ""}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Pi \u5DE5\u5177\u6CE8\u518C\u8868\u65E0\u6CD5\u89E3\u6790\uFF1A${error.message}`));
      }
    });
  });
}
function catalogEntries(config, section, installed) {
  const rows = installed.map(({ name, scope }) => {
    const entry = importEntry(config, section, name);
    return { key: entry?.key ?? null, name, access: entry?.access ?? "off", label: entry?.label ?? "", installed: true, scope };
  });
  for (const [key, entry] of Object.entries(config[section])) {
    if (!installed.some(({ name }) => matches(name, key))) {
      rows.push({ key, name: key, access: entry.access, label: entry.label ?? "", installed: false, scope: null });
    }
  }
  return rows;
}
async function resolveWorkerResourceCatalog({
  cwd = process.cwd(),
  agentDir,
  configPath = WORKER_RESOURCES_CONFIG,
  piCli = PI_CLI,
  toolCache = path13.join(cwd, ".runtime", "cockpit", "worker-tool-probe.json"),
  probeTools = probeRegisteredTools
} = {}) {
  const config = loadWorkerResourcesConfig(configPath);
  const found = await discoverWorkerResources({ cwd, agentDir, piCli });
  const diagnostics = found.missing.map((source) => ({ code: "not_installed", file: found.settingsPath, field: "packages", message: `\u5DF2\u914D\u7F6E\u7684 Pi \u8D44\u6E90\u672A\u5B89\u88C5\uFF1A${source}` }));
  const known = /* @__PURE__ */ new Set([...BUILTIN_TOOLS, ...RUNNER_TOOLS]);
  try {
    for (const name of await probeTools({ extensions: found.extensions, piCli, cacheFile: toolCache, cwd })) known.add(name);
  } catch (error) {
    diagnostics.push({ code: "tool_probe_failed", file: found.settingsPath, field: "extensions", message: `\u8BFB\u53D6\u5DF2\u88C5\u63D2\u4EF6\u6CE8\u518C\u7684\u5DE5\u5177\u5931\u8D25\uFF0C\u5DE5\u5177\u8868\u53EA\u542B\u5185\u7F6E\u5DE5\u5177\uFF1A${error.message}` });
  }
  const toolNames = [.../* @__PURE__ */ new Set([...known, ...Object.keys(config.tools), ...config.required_tools])].sort();
  return {
    configPath,
    settingsPath: found.settingsPath,
    tools: toolNames.map((name) => {
      const entry = config.tools[name];
      return {
        key: entry ? name : null,
        name,
        access: accessOf(config, "tools", name),
        label: entry?.label ?? "",
        group: entry?.group ?? "",
        installed: known.has(name) || config.required_tools.includes(name)
      };
    }),
    extensions: catalogEntries(config, "extensions", found.extensions),
    skills: catalogEntries(config, "skills", found.skills.filter((item) => item.scope === "user")),
    project_skills: found.skills.filter((item) => item.scope === "project").map(({ name, scope }) => ({ name, scope })),
    required_tools: config.required_tools,
    diagnostics
  };
}
var WORKER_RESOURCES_CONFIG, IMPORT_ACCESS, BUILTIN_TOOLS, RUNNER_TOOLS, PI_CLI, PROBE_TIMEOUT_MS, PROBE_SCRIPT, probes, SECTIONS, ENTRY_KEYS, REMOVED_KEYS;
var init_pi_worker_resources = __esm({
  async "ops/tools/pi_worker_resources.mjs"() {
    WORKER_RESOURCES_CONFIG = path13.resolve(path13.dirname(fileURLToPath2(import.meta.url)), "../templates/worker-resources.json");
    IMPORT_ACCESS = Object.freeze(["off", "optional", "default_on"]);
    BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
    RUNNER_TOOLS = Object.freeze(["research_search", "research_fetch", "command_job"]);
    PI_CLI = path13.join(process.env.APPDATA || path13.join(homedir3(), "AppData", "Roaming"), "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    PROBE_TIMEOUT_MS = 6e4;
    PROBE_SCRIPT = `import { pathToFileURL } from "node:url";
const { loadExtensions } = await import(pathToFileURL(process.env.PI_TOOL_PROBE_LOADER).href);
const { extensions, errors } = await loadExtensions(JSON.parse(process.env.PI_TOOL_PROBE_EXTENSIONS), process.cwd());
if (errors.length) throw new Error(errors.map(({ path, error }) => path + ": " + error).join("; "));
console.log(JSON.stringify([...new Set(extensions.flatMap((extension) => [...extension.tools.keys()]))]));
`;
    probes = /* @__PURE__ */ new Map();
    SECTIONS = Object.freeze(["tools", "extensions", "skills"]);
    ENTRY_KEYS = Object.freeze({ tools: ["access", "label", "group"], extensions: ["access", "label"], skills: ["access", "label"] });
    REMOVED_KEYS = Object.freeze({
      base_extensions: '\u6539\u5199\u4E3A extensions \u4E2D access = "default_on" \u7684\u6761\u76EE',
      main_only_extensions: '\u6539\u5199\u4E3A extensions \u4E2D access = "off" \u7684\u6761\u76EE',
      main_only_skills: '\u6539\u5199\u4E3A skills \u4E2D access = "off" \u7684\u6761\u76EE',
      force_excluded_tools: '\u6539\u5199\u4E3A tools \u4E2D access = "off" \u7684\u6761\u76EE'
    });
    if (path13.basename(process.argv[1] || "") === "pi_worker_resources.mjs") {
      if (process.argv.slice(2).some((arg) => arg !== "--json")) {
        console.error("Usage: node ops/tools/pi_worker_resources.mjs --json");
        process.exitCode = 2;
      } else {
        try {
          console.log(JSON.stringify(await resolveWorkerResourceCatalog(), null, 2));
        } catch (error) {
          console.error(error.message);
          process.exitCode = 1;
        }
      }
    }
  }
});

// ops/tools/dispatch-core/dispatch_prepare.mjs
import { spawnSync as spawnSync4 } from "node:child_process";
import { existsSync as existsSync8, mkdirSync as mkdirSync7, readdirSync as readdirSync6, readFileSync as readFileSync9, statSync as statSync9, writeFileSync as writeFileSync5 } from "node:fs";
import path14 from "node:path";
import process7 from "node:process";
function compareCodePoints2(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sortedStrings(values) {
  return [...values].sort(compareCodePoints2);
}
function pySlice(value, limit) {
  return Array.from(String(value)).slice(0, limit).join("");
}
function statOrNull3(target) {
  try {
    return statSync9(target);
  } catch {
    return null;
  }
}
function isFile3(target) {
  return Boolean(statOrNull3(target)?.isFile());
}
function isDirectory2(target) {
  return Boolean(statOrNull3(target)?.isDirectory());
}
function pathParts2(value) {
  return String(value ?? "").split(/[\\/]+/).filter((part) => part && part !== ".");
}
function shutilWhich(name) {
  const candidate = String(name ?? "");
  if (!candidate) return null;
  const isWindows = process7.platform === "win32";
  const exts = isWindows ? String(process7.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const hasExt = isWindows && exts.some((ext) => candidate.toLowerCase().endsWith(ext.toLowerCase()));
  const names = isWindows && !hasExt ? exts.map((ext) => candidate + ext) : [candidate];
  if (candidate.includes("/") || candidate.includes("\\")) {
    for (const item of names) if (isFile3(item)) return item;
    return null;
  }
  const dirs = String(process7.env.PATH || "").split(path14.delimiter).filter(Boolean);
  if (isWindows) dirs.unshift(process7.cwd());
  for (const dir of dirs) {
    for (const item of names) {
      const full = path14.join(dir, item);
      if (isFile3(full)) return full;
    }
  }
  return null;
}
function configSource(_configPath) {
  return "global";
}
function configBase(configPath) {
  return path14.dirname(String(configPath));
}
function resolveConfigPath(configPath, value) {
  const raw = String(value || ".");
  if (isAbsoluteLikePython(raw)) return resolveLikePython(raw);
  return resolveLikePython(pathlibJoin(configBase(configPath), raw));
}
function _serverFromConfig(configPath) {
  const config = loadToml(configPath);
  const rawServers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
  const serverName = ASYNC_MCP_SERVER_NAME;
  const server = rawServers[serverName];
  if (!isRecord(server)) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const env = isRecord(server.env) ? server.env : {};
  return {
    source: configSource(configPath),
    config_path: String(configPath),
    server_name: serverName,
    command: pyStr(pyTruthy(server.command) ? server.command : ""),
    args: args.map((item) => pyStr(item)),
    cwd: String(resolveConfigPath(configPath, pyStr(pyTruthy(server.cwd) ? server.cwd : "."))),
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), pyStr(value)])),
    approval_mode: pyStr(pyTruthy(server.default_tools_approval_mode) ? server.default_tools_approval_mode : "")
  };
}
function asyncSubagentServerImpl() {
  const envConfig = pyStrip(String(process7.env.COCKPIT_GLOBAL_CONFIG || ""));
  const globalConfig = deps.globalConfigPath || (envConfig || path14.join(homeDir(), ".codex", "config.toml"));
  return _serverFromConfig(globalConfig);
}
function asyncSubagentServer() {
  if (!caches.asyncSubagentServer.has("value")) {
    caches.asyncSubagentServer.set("value", deps.asyncSubagentServer());
  }
  return caches.asyncSubagentServer.get("value");
}
function asyncServerScriptPath(server) {
  const cwd = resolveLikePython(pyStr(pyTruthy(server?.cwd) ? server.cwd : ROOT));
  for (const arg of pyTruthy(server?.args) ? server.args : []) {
    if (pyStr(arg).endsWith(".mjs")) {
      const candidate = pyStr(arg);
      return isAbsoluteLikePython(candidate) ? resolveLikePython(candidate) : resolveLikePython(pathlibJoin(cwd, candidate));
    }
  }
  return null;
}
function asyncSubagentEndpointImpl() {
  const server = asyncSubagentServer();
  return [server, server ? asyncServerScriptPath(server) : null];
}
function asyncSubagentEndpoint() {
  if (!caches.asyncSubagentEndpoint.has("value")) {
    caches.asyncSubagentEndpoint.set("value", deps.asyncSubagentEndpoint());
  }
  return caches.asyncSubagentEndpoint.get("value");
}
function asyncServerEnv(server) {
  return { ...process7.env, ...pyTruthy(server?.env) ? server.env : {} };
}
function preflightPathIsSkipped(relative, { directory }) {
  const all = pathParts2(relative);
  const parts = directory ? all : all.slice(0, -1);
  if (parts.some((part) => PREFLIGHT_WALK_SKIP_DIRS.has(part))) return true;
  return PREFLIGHT_WALK_SKIP_PATHS.some(
    (prefix) => prefix.length <= all.length && prefix.every((part, index) => all[index] === part)
  );
}
function preflightGitRoot(baseRoot) {
  let completed;
  try {
    completed = spawnSync4("git", ["-C", String(baseRoot), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: PREFLIGHT_GIT_TIMEOUT_SECONDS * 1e3,
      windowsHide: true
    });
  } catch {
    return null;
  }
  if (completed.error) return null;
  const stdout = String(completed.stdout ?? "");
  if (completed.status !== 0 || !pyStrip(stdout)) return null;
  const root = resolveLikePython(pyStrip(stdout));
  return isDirectory2(root) ? root : null;
}
function preflightGitFiles(directory, gitRoot) {
  let relative;
  try {
    relative = relativePartsOrThrow(resolveLikePython(directory), resolveLikePython(gitRoot));
  } catch {
    return null;
  }
  const argv = ["-C", String(gitRoot), "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  if (relative.length) argv.push("--", relative.join("/"));
  let completed;
  try {
    completed = spawnSync4("git", argv, {
      timeout: PREFLIGHT_GIT_TIMEOUT_SECONDS * 1e3,
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024
    });
  } catch {
    return null;
  }
  if (completed.error) return null;
  if (completed.status !== 0) return null;
  const files = [];
  const raw = Buffer.isBuffer(completed.stdout) ? completed.stdout : Buffer.from(String(completed.stdout ?? ""));
  for (const chunk of raw.toString("utf8").split("\0")) {
    if (!chunk) continue;
    if (preflightPathIsSkipped(chunk, { directory: false })) continue;
    const candidate = path14.join(String(gitRoot), chunk);
    try {
      relativePartsOrThrow(resolveLikePython(candidate), resolveLikePython(directory));
    } catch {
      continue;
    }
    if (isFile3(candidate)) files.push(candidate);
  }
  return files;
}
function relativePartsOrThrow(child, parent) {
  if (!pyIsRelativeTo(child, parent)) throw new Error("not relative");
  return pathParts2(child).slice(pathParts2(parent).length);
}
function* walkDir(top, onError) {
  const stack = [String(top)];
  while (stack.length) {
    const dirpath = stack.pop();
    let entries;
    try {
      entries = readdirSync6(dirpath, { withFileTypes: true });
    } catch (error) {
      if (onError) onError(error, dirpath);
      continue;
    }
    const dirnames = [];
    const filenames = [];
    for (const entry of entries) {
      if (entry.isDirectory()) dirnames.push(entry.name);
      else filenames.push(entry.name);
    }
    const frame = { dirpath, dirnames, filenames };
    yield frame;
    for (let index = frame.dirnames.length - 1; index >= 0; index -= 1) {
      stack.push(path14.join(dirpath, frame.dirnames[index]));
    }
  }
}
function computeScopePreflight(readPaths, { baseRoot = ROOT } = {}) {
  let fileCount = 0;
  let totalBytes = 0;
  let largeFileCount = 0;
  let binaryLikeCount = 0;
  let truncated = false;
  let urlCount = 0;
  const missingPaths = [];
  const unreadablePaths = [];
  const resolvedBaseRoot = resolveLikePython(baseRoot);
  const gitRoot = preflightGitRoot(resolvedBaseRoot);
  const accountFile = (target) => {
    if (fileCount >= PREFLIGHT_STAT_FILE_CAP) {
      truncated = true;
      return false;
    }
    let size;
    try {
      size = statSync9(target).size;
    } catch (error) {
      unreadablePaths.push(`${target}: ${error.message}`);
      return true;
    }
    fileCount += 1;
    totalBytes += size;
    if (size > PREFLIGHT_LARGE_FILE_BYTES) largeFileCount += 1;
    if (PREFLIGHT_BINARY_LIKE_EXTENSIONS.has(path14.extname(String(target)).toLowerCase())) binaryLikeCount += 1;
    return true;
  };
  const recordWalkError = (error, filename) => {
    unreadablePaths.push(`${filename || baseRoot}: ${error.message}`);
  };
  for (const raw of readPaths) {
    if (truncated) break;
    const lowered = pyStrip(raw).toLowerCase();
    if (lowered.startsWith("http://") || lowered.startsWith("https://")) {
      urlCount += 1;
      continue;
    }
    const candidate = String(raw);
    const resolved = isAbsoluteLikePython(candidate) ? candidate : pathlibJoin(resolvedBaseRoot, candidate);
    let info;
    try {
      info = existsSync8(resolved) ? statSync9(resolved) : null;
    } catch (error) {
      unreadablePaths.push(`${raw}: ${error.message}`);
      continue;
    }
    if (!info) {
      missingPaths.push(raw);
      continue;
    }
    if (info.isFile()) {
      if (!accountFile(resolved)) break;
      continue;
    }
    if (!info.isDirectory()) {
      unreadablePaths.push(`${raw}: path is neither a regular file nor a directory`);
      continue;
    }
    const gitFiles = gitRoot !== null ? preflightGitFiles(resolved, gitRoot) : null;
    if (gitFiles !== null) {
      for (const item of gitFiles) {
        if (!accountFile(item)) break;
      }
      continue;
    }
    for (const frame of deps.walk(resolved, recordWalkError)) {
      let currentRelative;
      try {
        currentRelative = relativePartsOrThrow(resolveLikePython(frame.dirpath), resolvedBaseRoot).join("/");
      } catch {
        currentRelative = "";
      }
      frame.dirnames = frame.dirnames.filter(
        (name) => !preflightPathIsSkipped(currentRelative ? `${currentRelative}/${name}` : name, { directory: true })
      );
      let stop = false;
      for (const name of frame.filenames) {
        if (!accountFile(path14.join(frame.dirpath, name))) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
  }
  const result = {
    scope_file_count: fileCount,
    scope_total_bytes: totalBytes,
    scope_large_file_count: largeFileCount,
    scope_binary_like_count: binaryLikeCount,
    scope_stat_truncated: truncated,
    scope_url_count: urlCount,
    scope_missing_paths: missingPaths,
    scope_unreadable_paths: unreadablePaths,
    scope_preflight_warning: null
  };
  if (fileCount > PREFLIGHT_FILE_THRESHOLD || totalBytes > PREFLIGHT_BYTES_THRESHOLD) {
    result.scope_preflight_warning = `scope.read \u9884\u4F30 ${fileCount} \u4E2A\u6587\u4EF6\u3001${totalBytes} \u5B57\u8282\uFF0C\u8D85\u51FA\u9884\u8B66\u9608\u503C\uFF08\u6587\u4EF6 ${PREFLIGHT_FILE_THRESHOLD} / \u5B57\u8282 ${PREFLIGHT_BYTES_THRESHOLD}\uFF09\uFF1B\u5EFA\u8BAE\u6309 ops/skills/subagent-fleet-discipline/references/parallel-slicing.md \u7684\u4EA7\u80FD\u89C4\u683C\u62C6\u5206`;
  }
  return result;
}
function loadToml(target) {
  let text3;
  try {
    text3 = readFileSync9(String(target), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  let data;
  try {
    data = parse(text3);
  } catch (error) {
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  return isRecord(data) ? data : {};
}
function resolveDeliveryWithReadiness(delivery, readiness) {
  if (delivery !== "auto" && delivery !== "async-subagent") return [delivery, { status: "not_checked", issues: [] }];
  if (pyGetItem(readiness, "status") === "available") return ["async-subagent", readiness];
  return ["unavailable", readiness];
}
function resolveDeliveryImpl(delivery) {
  if (delivery !== "auto" && delivery !== "async-subagent") return [delivery, { status: "not_checked", issues: [] }];
  return resolveDeliveryWithReadiness(delivery, asyncSubagentReadiness());
}
function asyncDispatchContractStatus(buildInfo) {
  const current = pyStrip(pyStr(pyTruthy(buildInfo?.dispatch_contract_version) ? buildInfo.dispatch_contract_version : ""));
  const rawSupported = buildInfo?.supported_dispatch_contract_versions;
  let supported = Array.isArray(rawSupported) ? rawSupported.map((item) => pyStrip(pyStr(item))).filter((item) => item) : [];
  if (!supported.length && current) supported = [current];
  const compatible = supported.includes(ASYNC_DISPATCH_CONTRACT_VERSION);
  let issue = null;
  if (!current) {
    issue = "configured Async MCP build-info is missing dispatch_contract_version";
  } else if (!compatible) {
    issue = `configured Async MCP does not support ${ASYNC_DISPATCH_CONTRACT_VERSION} (current=${current}, supported=${pyRepr(supported)}); run npm --prefix ops run build:subagent and python -B ops/tools/deploy_subagent_bundle.py --apply --format json`;
  }
  return {
    current: current || null,
    supported,
    compatible: compatible && Boolean(current),
    issue
  };
}
function asyncSubagentReadinessImpl() {
  const issues = [];
  const [server, toolPath] = asyncSubagentEndpoint();
  let buildInfo = {};
  let contractStatus = asyncDispatchContractStatus(buildInfo);
  if (!pyTruthy(server)) {
    issues.push(
      "mcp_servers.asyncSubagent is missing from the user-level config (~/.codex/config.toml); project-level registration does not select the service; run python -B ops/tools/deploy_subagent_bundle.py --apply to publish and register the server"
    );
  } else if (!pyTruthy(server.command)) {
    issues.push("mcp_servers.asyncSubagent.command is empty");
  } else if (server.approval_mode !== "approve") {
    issues.push("mcp_servers.asyncSubagent.default_tools_approval_mode must be approve");
  }
  if (pyTruthy(toolPath) && !isFile3(toolPath)) {
    issues.push(`missing async tool: ${toolPath}`);
  } else if (!pyTruthy(toolPath)) {
    issues.push("mcp_servers.asyncSubagent args do not include an .mjs server script");
  }
  if (!issues.length) {
    try {
      buildInfo = deps.callAsyncInternalAdapter("build-info", {});
      contractStatus = asyncDispatchContractStatus(buildInfo);
      if (contractStatus.issue) issues.push(pyStr(contractStatus.issue));
    } catch (error) {
      if (error?.name !== "ToolError") throw error;
      issues.push(`cannot read configured Async MCP build-info: ${error.message}`);
    }
  }
  return {
    status: issues.length ? "unavailable" : "available",
    issues,
    server_source: pyTruthy(server) ? server.source : null,
    registration_policy: "MCP\u670D\u52A1\u4F7F\u7528\u7528\u6237\u7EA7\u6CE8\u518C\uFF1B\u9879\u76EE\u540C\u540D\u6CE8\u518C\u4E0D\u53C2\u4E0E\u9009\u5740\u3002",
    config_path: pyTruthy(server) ? server.config_path : null,
    server_name: pyTruthy(server) ? server.server_name : null,
    tool_path: pyTruthy(toolPath) ? String(toolPath) : null,
    approval_mode: pyTruthy(server) ? server.approval_mode : null,
    build_id: pyStr(pyTruthy(buildInfo?.build_id) ? buildInfo.build_id : "") || null,
    dispatch_contract_version: contractStatus.current,
    supported_dispatch_contract_versions: contractStatus.supported
  };
}
function asyncSubagentReadiness() {
  if (!caches.asyncSubagentReadiness.has("value")) {
    caches.asyncSubagentReadiness.set("value", deps.asyncSubagentReadiness());
  }
  return caches.asyncSubagentReadiness.get("value");
}
function callAsyncInternalAdapterImpl(operation, args) {
  const [server, toolPath] = asyncSubagentEndpoint();
  if (!pyTruthy(server)) {
    throw new ToolError(
      "async subagent MCP server is missing from the user-level config (~/.codex/config.toml); register it with python -B ops/tools/deploy_subagent_bundle.py --apply and re-check build-info with --delivery auto, or dispatch through the Pi native dispatch_prepare tool, which uses the session AsyncTaskService instead of this endpoint"
    );
  }
  if (!pyTruthy(toolPath) || !isFile3(toolPath)) {
    throw new ToolError("configured async subagent MCP server script is unavailable");
  }
  const argv = [String(toolPath), "internal", operation];
  for (const [key, value] of Object.entries(args || {})) {
    if (value === null || value === void 0 || value === "" || Array.isArray(value) && value.length === 0) continue;
    const flag = `--${key.split("_").join("-")}`;
    if (Array.isArray(value)) argv.push(flag, value.map((item) => pyStr(item)).join(","));
    else if (typeof value === "boolean") {
      if (value) argv.push(flag);
    } else argv.push(flag, pyStr(value));
  }
  const completed = pySpawnSync(pyStr(pyGetItem(server, "command")), argv, {
    cwd: String(pyGetItem(server, "cwd")),
    env: asyncServerEnv(server),
    encoding: "utf8",
    timeout: 3e4,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (completed.error) {
    if (completed.error.code === "ETIMEDOUT") {
      throw new ToolError("async subagent internal submit timed out before returning task_id");
    }
    throw new ToolError("node is not available for async subagent MCP dispatch");
  }
  if (completed.signal === "SIGTERM" && completed.status === null) {
    throw new ToolError("async subagent internal submit timed out before returning task_id");
  }
  const stdout = String(completed.stdout ?? "");
  const stderr = String(completed.stderr ?? "");
  if (completed.status !== 0) {
    throw new ToolError(`async subagent internal adapter failed: ${pySlice(pyStrip(stderr || stdout), 600)}`);
  }
  let response;
  try {
    response = pyJsonLoads(stdout);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`async subagent internal adapter returned invalid JSON: ${pySlice(stdout, 600)}`);
  }
  if (!isRecord(response) || response.ok === false) {
    throw new ToolError(`async subagent internal adapter failed: ${pyStr(response)}`);
  }
  return response;
}
function agentConfigEntryImpl(agentType) {
  return loadRoleConfig(agentType);
}
function piChildCatalogCommandImpl() {
  const configured = pyStrip(String(process7.env.PI_CONTROL_PI || ""));
  if (configured) {
    const suffix = path14.extname(configured).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(suffix)) {
      const node = shutilWhich("node");
      return node ? [node, configured] : [];
    }
    return [configured];
  }
  let executable = process7.platform === "win32" ? shutilWhich("pi.cmd") : shutilWhich("pi");
  if (!executable && process7.platform === "win32") executable = shutilWhich("pi");
  return executable ? [executable] : [];
}
function piChildCatalogCommand() {
  return deps.piChildCatalogCommand();
}
function piChildModelExtensionProfileImpl() {
  if (pyStrip(String(process7.env.PI_CONTROL_PI || ""))) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: null };
  }
  let extensions;
  try {
    extensions = resolvePiChildModelExtensions();
  } catch (error) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: pySlice(String(error?.message ?? error), 500) };
  }
  if (!extensions.every((item) => typeof item === "string" && isAbsoluteLikePython(item) && isFile3(item))) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: "model extension profile returned invalid paths" };
  }
  return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions, error: null };
}
function piChildModelExtensionProfile() {
  if (!caches.piChildModelExtensionProfile.has("value")) {
    caches.piChildModelExtensionProfile.set("value", deps.piChildModelExtensionProfile());
  }
  return caches.piChildModelExtensionProfile.get("value");
}
function probePiChildModelCatalogUncachedImpl(targetCwd) {
  const command = piChildCatalogCommand();
  const extensionProfile = piChildModelExtensionProfile();
  if (!command.length || pyTruthy(extensionProfile.error)) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: "pi --list-models (child model profile)",
      error: pyTruthy(extensionProfile.error) ? extensionProfile.error : "Pi executable not found"
    };
  }
  const argv = [...command.slice(1), "-ne", "-ns", "-np", "--no-themes", "-nc", "--no-approve"];
  for (const extensionPath of extensionProfile.extensions) argv.push("-e", extensionPath);
  argv.push("--list-models");
  const completed = pySpawnSync(command[0], argv, {
    cwd: String(targetCwd),
    encoding: "utf8",
    timeout: 3e4,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (completed.error) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: `pi --list-models (${extensionProfile.profile})`,
      error: pySlice(String(completed.error.message ?? completed.error), 500)
    };
  }
  const stdout = String(completed.stdout ?? "");
  const stderr = String(completed.stderr ?? "");
  if (completed.status !== 0) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: `pi --list-models (${extensionProfile.profile})`,
      error: pySlice(pyStrip(stderr || stdout), 500)
    };
  }
  const models = /* @__PURE__ */ new Set();
  const details = {};
  for (const line of pySplitLines(stdout)) {
    const columns = line.split(PY_SPLIT_RE).filter((item) => item !== "");
    if (columns.length < 2 || columns[0].toLowerCase() === "provider") continue;
    const provider = pyStrip(columns[0]);
    const modelId = pyStrip(columns[1]);
    if (!provider || !modelId) continue;
    const key = `${provider}/${modelId}`;
    models.add(key);
    const images = columns.length >= 6 ? pyStrip(columns[5]).toLowerCase() : "";
    details[key] = {
      context_window: columns.length >= 3 ? pyStrip(columns[2]) || null : null,
      supports_vision: images === "yes" ? true : images === "no" ? false : null
    };
  }
  if (!models.size) {
    return {
      status: "unavailable",
      models: [],
      model_count: 0,
      source: `pi --list-models (${extensionProfile.profile})`,
      error: "Pi returned no parseable child models"
    };
  }
  const ordered = sortedStrings(models);
  return {
    status: "ok",
    models: ordered,
    model_details: Object.fromEntries(ordered.map((key) => [key, details[key]])),
    model_count: ordered.length,
    source: `pi --list-models (${extensionProfile.profile})`,
    error: null
  };
}
function piChildCatalogCacheIdentity(targetCwd) {
  const command = piChildCatalogCommand();
  const extensionProfile = piChildModelExtensionProfile();
  const extensions = Array.isArray(extensionProfile.extensions) ? extensionProfile.extensions : [];
  const agentDir = resolvePiAgentDir();
  const configPaths = [
    ...extensions,
    ...CHILD_CATALOG_CONFIG_SURFACE.map((name) => path14.join(agentDir, ...String(name).split("/")))
  ];
  return {
    schema: CATALOG_CACHE_SCHEMA,
    platform: process7.platform,
    pi_control_pi: pyStrip(String(process7.env.PI_CONTROL_PI || "")),
    command,
    extension_profile: {
      profile: extensionProfile.profile,
      extensions,
      error: extensionProfile.error ?? null
    },
    config_fingerprints: fingerprintPaths(configPaths),
    target_cwd: String(targetCwd)
  };
}
function piChildCatalogCacheFile() {
  const override = pyStrip(String(process7.env.SUBAGENT_CATALOG_CACHE_DIR || ""));
  const cacheDir = override ? resolveLikePython(override) : path14.join(ROOT, ".runtime", "cockpit", "cache");
  return path14.join(cacheDir, CATALOG_CACHE_FILE_NAME);
}
function childCatalogFileLayerEnabled() {
  return deps.probePiChildModelCatalogUncached === probePiChildModelCatalogUncachedImpl;
}
function rememberChildCatalog(key, value) {
  caches.childModelCatalog.set(key, value);
  while (caches.childModelCatalog.size > 8) {
    caches.childModelCatalog.delete(caches.childModelCatalog.keys().next().value);
  }
  return value;
}
function probePiChildModelCatalogFresh(key, { cacheWrite = false } = {}) {
  let identityBefore = null;
  if (cacheWrite && childCatalogFileLayerEnabled()) {
    try {
      identityBefore = piChildCatalogCacheIdentity(key);
    } catch {
    }
  }
  const value = deps.probePiChildModelCatalogUncached(key);
  rememberChildCatalog(key, value);
  if (identityBefore && value?.status === "ok") {
    try {
      const identity = piChildCatalogCacheIdentity(key);
      if (catalogCacheKey(identityBefore) === catalogCacheKey(identity)) {
        writeCatalogCacheEntry(piChildCatalogCacheFile(), catalogCacheKey(identity), identity, value);
      }
    } catch {
    }
  }
  return value;
}
function probePiChildModelCatalogImpl(targetCwd, options = {}) {
  const key = String(targetCwd);
  if (caches.childModelCatalog.has(key)) {
    const value = caches.childModelCatalog.get(key);
    caches.childModelCatalog.delete(key);
    caches.childModelCatalog.set(key, value);
    return value;
  }
  if (childCatalogFileLayerEnabled()) {
    let cached = null;
    try {
      const identity = piChildCatalogCacheIdentity(key);
      cached = readCatalogCacheEntry(piChildCatalogCacheFile(), catalogCacheKey(identity));
    } catch {
      cached = null;
    }
    if (cached) {
      cacheServedCatalogs.add(cached.catalog);
      return rememberChildCatalog(key, cached.catalog);
    }
  }
  return probePiChildModelCatalogFresh(key, options);
}
function resolveFromPicks(agentType, capability, options = {}) {
  const selection = resolveSelection(loadSelectionConfig(modelConfigSources()), {
    role: agentType,
    capability,
    pick: options.pick || null,
    model: options.model || null,
    effort: options.effort || null,
    authorization: options.authorization || null
  });
  return {
    agent_type: agentType,
    executor: "pi",
    primary_model: selection.resolved_model,
    primary_effort: selection.resolved_effort,
    model_source: selection.requested.model ? "cli" : selection.requested.pick ? "pick" : "agent_config",
    effort_source: selection.effort_source === "explicit" ? "cli" : selection.effort_source,
    selection
  };
}
function resolveRoleModelSelection(agentTypeRaw, modelOverride, effortOverride, capability = "", options = {}) {
  const agentType = pyStrip(pyStr(pyTruthy(agentTypeRaw) ? agentTypeRaw : ""));
  if (!agentType) throw new ToolError("invalid runtime role: (empty)");
  const capabilityId = pyStrip(pyStr(pyTruthy(capability) ? capability : ""));
  if (!capabilityId) throw new ToolError(`selection requires capability for role ${agentType}`);
  return resolveFromPicks(agentType, capabilityId, {
    model: modelOverride,
    effort: effortOverride,
    pick: options.pick,
    authorization: options.authorization
  });
}
var PREFLIGHT_FILE_THRESHOLD, PREFLIGHT_BYTES_THRESHOLD, PREFLIGHT_LARGE_FILE_BYTES, PREFLIGHT_WALK_SKIP_DIRS, PREFLIGHT_WALK_SKIP_PATHS, PREFLIGHT_GIT_TIMEOUT_SECONDS, PREFLIGHT_STAT_FILE_CAP, PREFLIGHT_BINARY_LIKE_EXTENSIONS, ASYNC_MCP_SERVER_NAME, ASYNC_DISPATCH_CONTRACT_VERSION, PROJECT_ASYNC_TASK_ROOT, deps, caches, PY_SPLIT_RE, CHILD_CATALOG_CONFIG_SURFACE, cacheServedCatalogs;
var init_dispatch_prepare = __esm({
  async "ops/tools/dispatch-core/dispatch_prepare.mjs"() {
    init_tool_common();
    init_py();
    init_dist();
    init_model_catalog_cache();
    init_agent_panel_launcher();
    init_prepared_dispatch();
    init_review_evidence();
    init_seed_minimal();
    init_subagent_preload();
    init_task_package_build();
    init_task_package_lint();
    init_task_package_profiles();
    init_pi_model_extension_profile();
    init_model_selection();
    await init_pi_worker_resources();
    PREFLIGHT_FILE_THRESHOLD = 400;
    PREFLIGHT_BYTES_THRESHOLD = 10 * 1024 * 1024;
    PREFLIGHT_LARGE_FILE_BYTES = 2 * 1024 * 1024;
    PREFLIGHT_WALK_SKIP_DIRS = /* @__PURE__ */ new Set([".git", ".runtime", "node_modules", "__pycache__", "tmp"]);
    PREFLIGHT_WALK_SKIP_PATHS = [["ops", "dist"]];
    PREFLIGHT_GIT_TIMEOUT_SECONDS = 15;
    PREFLIGHT_STAT_FILE_CAP = 2e4;
    PREFLIGHT_BINARY_LIKE_EXTENSIONS = /* @__PURE__ */ new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".pdf",
      ".zip",
      ".7z",
      ".dwg",
      ".dxf",
      ".step",
      ".stp",
      ".iges",
      ".igs",
      ".exe",
      ".dll",
      ".bin",
      ".dat",
      ".mp4",
      ".avi"
    ]);
    ASYNC_MCP_SERVER_NAME = "asyncSubagent";
    ASYNC_DISPATCH_CONTRACT_VERSION = DISPATCH_CONTRACT_VERSION;
    PROJECT_ASYNC_TASK_ROOT = path14.join(ROOT, ".runtime", "cockpit", "async_tasks");
    deps = {
      // Python GLOBAL_CONFIG_PATH（Path | None）
      globalConfigPath: null,
      ensureAgentPanel,
      walk: walkDir,
      agentConfigEntry: agentConfigEntryImpl,
      piChildCatalogCommand: piChildCatalogCommandImpl,
      piChildModelExtensionProfile: piChildModelExtensionProfileImpl,
      probePiChildModelCatalogUncached: probePiChildModelCatalogUncachedImpl,
      probePiChildModelCatalog: probePiChildModelCatalogImpl,
      callAsyncInternalAdapter: callAsyncInternalAdapterImpl,
      asyncSubagentServer: asyncSubagentServerImpl,
      asyncSubagentEndpoint: asyncSubagentEndpointImpl,
      asyncSubagentReadiness: asyncSubagentReadinessImpl,
      resolveDelivery: resolveDeliveryImpl,
      compilePreparedDispatch,
      verifyPreparedDispatch,
      attachReviewEvidence
    };
    caches = {
      asyncSubagentServer: /* @__PURE__ */ new Map(),
      asyncSubagentEndpoint: /* @__PURE__ */ new Map(),
      asyncSubagentReadiness: /* @__PURE__ */ new Map(),
      piChildModelExtensionProfile: /* @__PURE__ */ new Map(),
      childModelCatalog: /* @__PURE__ */ new Map()
    };
    PY_SPLIT_RE = new RegExp(`[${PY_SPACE_CLASS}]+`);
    CHILD_CATALOG_CONFIG_SURFACE = Object.freeze([
      "models.json",
      "models-store.json",
      "settings.json",
      "npm/package.json"
    ]);
    cacheServedCatalogs = /* @__PURE__ */ new WeakSet();
  }
});

// ops/tools/dispatch-core/fleet_manifest_check.mjs
import path15 from "node:path";
function compareCodePoints3(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sortedStrings2(values) {
  return [...values].sort(compareCodePoints3);
}
function sortedKeysMinus(container, allowed) {
  return sortedStrings2(Object.keys(container ?? {}).filter((key) => !allowed.has(key)));
}
function deepCopy2(value) {
  if (Array.isArray(value)) return value.map(deepCopy2);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCopy2(item)]));
  }
  return value;
}
function purePathParts(value) {
  const raw = String(value);
  const root = path15.parse(raw).root;
  const rest = raw.slice(root.length).split(/[\\/]+/).filter((part) => part && part !== ".");
  return root ? [root, ...rest] : rest;
}
function loadManifest(target) {
  const text3 = (() => {
    try {
      return pyReadText(target);
    } catch (error) {
      if (error?.code === "ENOENT") throw new ToolError(`fleet manifest not found: ${pyPureStr(target)}`);
      throw error;
    }
  })();
  let data;
  try {
    data = pyJsonLoads(text3);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    const lineno = Number(/line (\d+) column/.exec(String(error.message))?.[1] ?? 1);
    throw new ToolError(`fleet manifest is invalid JSON: ${pyPureStr(target)}:${lineno}`);
  }
  if (!isRecord(data)) throw new ToolError("fleet manifest root must be a JSON object");
  return data;
}
function effectiveBudget(manifest) {
  const raw = isRecord(manifest.budget) ? manifest.budget : {};
  return { ...deepCopy2(DEFAULT_BUDGET), ...raw };
}
function effectiveReviewPolicy(manifest) {
  const raw = isRecord(manifest.review_policy) ? manifest.review_policy : {};
  return { ...deepCopy2(DEFAULT_REVIEW_POLICY), ...raw };
}
function manifestNodes(manifest) {
  const nodes = manifest.nodes;
  if (!Array.isArray(nodes)) throw new ToolError("fleet manifest requires nodes: []");
  return nodes.map((node) => isRecord(node) ? node : { _invalid_node: node });
}
function nodeId(node) {
  const value = node.id;
  return typeof value === "string" ? pyStrip(value) : "";
}
function nodeSeed(node) {
  const seed = node.seed;
  return isRecord(seed) ? deepCopy2(seed) : {};
}
function nodeSeedForStaticValidation(node) {
  const seed = nodeSeed(node);
  const artifacts = node.dependency_artifacts;
  if (!Array.isArray(artifacts) || !artifacts.some((item) => typeof item === "string" && pyStrip(item))) {
    return seed;
  }
  let scope = seed.scope;
  if (!isRecord(scope)) {
    scope = {};
    seed.scope = scope;
  }
  const reads = scope.read;
  if (!Array.isArray(reads) || !reads.some((item) => typeof item === "string" && pyStrip(item))) {
    scope.read = ["ops/tools/fleet_manifest_check.mjs"];
  }
  return seed;
}
function nodeExpandedSeed(node) {
  try {
    return deps2.expandSeed(nodeSeedForStaticValidation(node));
  } catch {
    return nodeSeed(node);
  }
}
function nodeRouteId(node) {
  const seed = nodeSeed(node);
  const value = seed.route_id;
  return typeof value === "string" ? pyStrip(value) : "";
}
function nodeRoute(node) {
  const raw = node.route;
  if (!isRecord(raw)) return null;
  const out = {};
  for (const key of sortedStrings2(ALLOWED_ROUTE_FIELDS)) {
    const value = raw[key];
    if (key === "authorization") {
      if (isRecord(value) || typeof value === "string" && pyStrip(value)) out.authorization = isRecord(value) ? deepCopy2(value) : pyStrip(value);
      continue;
    }
    if (typeof value === "string" && pyStrip(value)) out[key] = pyStrip(pyStr(value));
  }
  return out;
}
function nodeRouteSource(node) {
  return Object.hasOwn(node, "route") ? EXPLICIT_ROUTE_SOURCE : LEGACY_ROUTE_SOURCE;
}
function nodeRouteErrors(node) {
  if (!Object.hasOwn(node, "route")) return [];
  const raw = node.route;
  if (!isRecord(raw)) return ["route must be an object"];
  const errors = [];
  for (const field of sortedKeysMinus(raw, ALLOWED_ROUTE_FIELDS)) {
    errors.push(`route has unsupported field: ${field}`);
  }
  for (const field of sortedStrings2(ROUTE_STRING_FIELDS)) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field];
    if (typeof value !== "string" || !pyStrip(value)) {
      errors.push(`route.${field} must be a non-empty string`);
    }
  }
  if (ROUTE_SELECTORS.filter((field) => Object.hasOwn(raw, field)).length > 1) {
    errors.push("route pick and model are mutually exclusive");
  }
  if (Object.hasOwn(raw, "authorization")) {
    let parsed = raw.authorization;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        errors.push("route.authorization must be a JSON object");
        parsed = null;
      }
    }
    if (parsed !== null && !isRecord(parsed)) errors.push("route.authorization must be an object");
    if (isRecord(parsed)) {
      if (typeof parsed.quote !== "string" || !pyStrip(parsed.quote)) errors.push("route.authorization.quote must be a non-empty string");
      if (!Array.isArray(parsed.overrides)) errors.push("route.authorization.overrides must be an array");
      if (!pyStrip(pyStr(raw.effort || ""))) errors.push("route.authorization requires route.effort");
    }
  }
  const executor = raw.executor;
  if (typeof executor === "string" && pyStrip(executor) && !ALLOWED_EXECUTORS.has(executor)) {
    errors.push(`route.executor must be one of ${pyRepr(sortedStrings2(ALLOWED_EXECUTORS))}`);
  }
  return errors;
}
function nodeKind(node) {
  const value = node.kind;
  if (typeof value === "string" && pyStrip(value)) return pyStrip(value);
  return "task";
}
function nodeKindErrors(node) {
  const value = node.kind;
  if (value === null || value === void 0) return [];
  if (typeof value !== "string" || !ALLOWED_NODE_KINDS.has(pyStrip(value))) {
    return [`kind must be one of ${pyRepr(sortedStrings2(ALLOWED_NODE_KINDS))}`];
  }
  return [];
}
function nodeCommand(node) {
  const raw = node.command;
  if (!isRecord(raw)) return {};
  const argv = raw.argv;
  const timeout = Object.hasOwn(raw, "timeout_seconds") ? raw.timeout_seconds : COMMAND_DEFAULT_TIMEOUT_SECONDS;
  const cwd = raw.cwd;
  const timeoutValid = typeof timeout === "number" && Number.isInteger(timeout);
  return {
    argv: Array.isArray(argv) ? argv.map((item) => pyStr(item)) : [],
    cwd: typeof cwd === "string" && pyStrip(cwd) ? pyStrip(cwd) : "",
    timeout_seconds: timeoutValid ? timeout : COMMAND_DEFAULT_TIMEOUT_SECONDS
  };
}
function nodeCommandErrors(node) {
  const raw = Object.hasOwn(node, "command") ? node.command : null;
  if (raw === null || raw === void 0) return ["kind=command requires command object"];
  if (!isRecord(raw)) return ["command must be an object"];
  const errors = [];
  for (const field of sortedKeysMinus(raw, ALLOWED_COMMAND_FIELDS)) {
    errors.push(`command has unsupported field: ${field}`);
  }
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== "string" || !pyStrip(item))) {
    errors.push("command.argv must be a non-empty array of non-empty strings");
  }
  const cwd = Object.hasOwn(raw, "cwd") ? raw.cwd : null;
  if (cwd !== null && cwd !== void 0) {
    if (typeof cwd !== "string" || !pyStrip(cwd)) {
      errors.push("command.cwd must be a non-empty string when present");
    } else if (isAbsoluteLikePython(cwd) || purePathParts(cwd).includes("..")) {
      errors.push("command.cwd must be a repo-relative path without parent escapes");
    }
  }
  const timeout = Object.hasOwn(raw, "timeout_seconds") ? raw.timeout_seconds : null;
  if (timeout !== null && timeout !== void 0 && (typeof timeout === "boolean" || typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0 || timeout > COMMAND_MAX_TIMEOUT_SECONDS)) {
    errors.push(`command.timeout_seconds must be a positive integer <= ${COMMAND_MAX_TIMEOUT_SECONDS}`);
  }
  return errors;
}
function nodeRole(node) {
  const kind = nodeKind(node);
  if (kind !== "task") return kind;
  const routeId2 = nodeRouteId(node);
  return routeId2.includes("__") ? routeId2.split("__")[0] : routeId2;
}
function nodeDependsOn(node) {
  const raw = Object.hasOwn(node, "depends_on") ? node.depends_on : [];
  if (raw === null || raw === void 0) return [];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => typeof item === "string" && pyStrip(item)).map((item) => pyStrip(item));
}
function nodeDependsOnErrors(node) {
  const raw = Object.hasOwn(node, "depends_on") ? node.depends_on : [];
  if (raw === null || raw === void 0) return [];
  if (!Array.isArray(raw)) return ["depends_on must be a list"];
  const errors = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !pyStrip(item)) {
      errors.push(`depends_on[${index}] must be a non-empty string`);
    }
  });
  return errors;
}
function nodeDependencyArtifacts(node) {
  return stringList2(node.dependency_artifacts);
}
function nodeDependencyArtifactErrors(node) {
  const raw = Object.hasOwn(node, "dependency_artifacts") ? node.dependency_artifacts : [];
  if (raw === null || raw === void 0) return [];
  if (!Array.isArray(raw)) return ["dependency_artifacts must be a list"];
  const errors = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !ALLOWED_DEPENDENCY_ARTIFACTS.has(item)) {
      errors.push(
        `dependency_artifacts[${index}] must be one of ${pyRepr(sortedStrings2(ALLOWED_DEPENDENCY_ARTIFACTS))}`
      );
    }
  });
  if (raw.length && !nodeDependsOn(node).length) {
    errors.push("dependency_artifacts requires depends_on");
  }
  return errors;
}
function nodeDependencyPolicy(node) {
  const value = Object.hasOwn(node, "dependency_policy") ? node.dependency_policy : "all_succeeded";
  return typeof value === "string" && pyStrip(value) ? pyStrip(value) : "all_succeeded";
}
function nodeDependencyPolicyErrors(node) {
  const raw = Object.hasOwn(node, "dependency_policy") ? node.dependency_policy : "all_succeeded";
  if (typeof raw !== "string" || !ALLOWED_DEPENDENCY_POLICIES.has(raw)) {
    return [`dependency_policy must be one of ${pyRepr(sortedStrings2(ALLOWED_DEPENDENCY_POLICIES))}`];
  }
  if (Object.hasOwn(node, "dependency_policy") && !nodeDependsOn(node).length) {
    return ["dependency_policy requires depends_on"];
  }
  return [];
}
function nodeResourceLocks(node) {
  return sortedStrings2(new Set(
    stringList2(node.resource_locks).map((item) => pyStrip(item)).filter((item) => item)
  ));
}
function nodeResourceLockErrors(node) {
  const raw = Object.hasOwn(node, "resource_locks") ? node.resource_locks : [];
  if (raw === null || raw === void 0) return [];
  if (!Array.isArray(raw)) return ["resource_locks must be a list"];
  const errors = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !pyStrip(item)) {
      errors.push(`resource_locks[${index}] must be a non-empty string`);
      return;
    }
  });
  return errors;
}
function nodeFailurePolicy(node) {
  const value = Object.hasOwn(node, "failure_policy") ? node.failure_policy : "success_only";
  return typeof value === "string" && pyStrip(value) ? pyStrip(value) : "success_only";
}
function nodeFailurePolicyErrors(node) {
  const raw = Object.hasOwn(node, "failure_policy") ? node.failure_policy : "success_only";
  if (typeof raw !== "string" || !ALLOWED_FAILURE_POLICIES.has(raw)) {
    return [`failure_policy must be one of ${pyRepr(sortedStrings2(ALLOWED_FAILURE_POLICIES))}`];
  }
  return [];
}
function nodeIsReducer(node) {
  return node.reducer === true;
}
function nodeReducerErrors(node) {
  const raw = Object.hasOwn(node, "reducer") ? node.reducer : false;
  if (typeof raw !== "boolean") return ["reducer must be a boolean"];
  if (raw && nodeDependencyPolicy(node) !== "all_settled") {
    return ["reducer=true requires dependency_policy=all_settled"];
  }
  return [];
}
function nodeIsolation(node, manifest) {
  const defaults = isRecord(manifest.defaults) ? manifest.defaults : {};
  const fallback = Object.hasOwn(defaults, "isolation") ? defaults.isolation : "same_tree_locked";
  const value = Object.hasOwn(node, "isolation") ? node.isolation : fallback;
  return typeof value === "string" && pyStrip(value) ? value : "same_tree_locked";
}
function stringList2(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && pyStrip(item));
}
function nodeScope(node) {
  const seed = nodeExpandedSeed(node);
  const scope = isRecord(seed.scope) ? seed.scope : {};
  return {
    read: stringList2(scope.read),
    write: [...stringList2(scope.write), ...stringList2(scope.write_extra)],
    delete: stringList2(scope.delete)
  };
}
function nodeReadScope(node) {
  const seed = nodeSeed(node);
  const scope = isRecord(seed.scope) ? seed.scope : {};
  const rawReads = scope.read;
  if (nodeDependencyArtifacts(node).length && (!Array.isArray(rawReads) || !rawReads.some((item) => typeof item === "string" && pyStrip(item)))) {
    return [];
  }
  return nodeScope(node).read;
}
function nodeWriteScope(node) {
  const seed = nodeExpandedSeed(node);
  const scope = nodeScope(node);
  const writes = [...scope.write, ...scope.delete];
  const expected = isRecord(seed.expected_output) ? seed.expected_output : {};
  const handoff = isRecord(seed.handoff_contract) ? seed.handoff_contract : {};
  writes.push(...stringList2(node.write_scope));
  writes.push(...stringList2(node.write_domains));
  for (const key of ["file_path", "path"]) {
    const value = expected[key];
    if (typeof value === "string" && pyStrip(value)) writes.push(value);
  }
  const handoffFile = handoff.handoff_file;
  if (typeof handoffFile === "string" && pyStrip(handoffFile)) writes.push(handoffFile);
  return sortedStrings2(new Set(writes.filter((item) => pyStrip(item)).map((item) => normalizeConflictPath(item))));
}
function nodeTargetIsolation(node, manifest) {
  const defaults = isRecord(manifest.defaults) ? manifest.defaults : {};
  const fallback = Object.hasOwn(defaults, "target_isolation") ? defaults.target_isolation : "writable";
  const value = Object.hasOwn(node, "target_isolation") ? node.target_isolation : fallback;
  return typeof value === "string" && pyStrip(value) ? value : "writable";
}
function nodeArtifactWriteScope(node) {
  const raw = stringList2(node.artifact_write_scope);
  return sortedStrings2(new Set(raw.filter((item) => pyStrip(item)).map((item) => normalizeConflictPath(item))));
}
function nodeReadScopeLayers(node) {
  const seed = nodeExpandedSeed(node);
  const layers = seed.read_scope_layers;
  if (!isRecord(layers)) return null;
  const flat = (key) => {
    const out = [];
    const items = Array.isArray(layers[key]) ? layers[key] : [];
    for (const item of items) {
      if (typeof item === "string" && pyStrip(item)) out.push(item);
      else if (isRecord(item) && typeof item.path === "string" && pyStrip(item.path)) out.push(item.path);
    }
    return out;
  };
  return { entry: flat("entry"), index: flat("index"), deep: flat("deep"), deferred: flat("deferred") };
}
function pathHitsBigDir(raw) {
  const segments = pyStrip(String(raw).replace(/\\/g, "/")).toLowerCase().split("/").filter(Boolean);
  return segments.some((seg) => BIG_DIR_NAMES.has(seg));
}
function nodeQuestionTexts(node) {
  const seed = nodeSeed(node);
  const texts = [];
  for (const value of [seed.goal]) {
    if (typeof value === "string" && pyStrip(value)) texts.push(value);
  }
  const contract = isRecord(seed.contract) ? seed.contract : {};
  const question = contract.question;
  if (typeof question === "string" && pyStrip(question)) texts.push(question);
  return texts;
}
function writeScopesConflict(left, right) {
  const hits = [];
  for (const a of left) {
    for (const b of right) {
      if (pathConflict(a, b)) hits.push([a, b]);
    }
  }
  return hits;
}
function topologicalLayers(nodes) {
  const ids2 = nodes.map((node) => nodeId(node));
  const idSet = new Set(ids2);
  const indegree = /* @__PURE__ */ new Map();
  const children = /* @__PURE__ */ new Map();
  for (const item of ids2) {
    if (!indegree.has(item)) indegree.set(item, 0);
    if (!children.has(item)) children.set(item, []);
  }
  const problems = [];
  for (const node of nodes) {
    const nid = nodeId(node);
    for (const dep of nodeDependsOn(node)) {
      if (!idSet.has(dep)) {
        problems.push(`node ${nid} depends on missing node ${dep}`);
        continue;
      }
      indegree.set(nid, indegree.get(nid) + 1);
      children.get(dep).push(nid);
    }
  }
  let ready = sortedStrings2([...indegree.entries()].filter(([, count]) => count === 0).map(([item]) => item));
  const layers = [];
  const seen = [];
  while (ready.length) {
    const layer = ready;
    layers.push(layer);
    const nextReady = [];
    for (const item of layer) {
      seen.push(item);
      for (const child of children.get(item)) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) nextReady.push(child);
      }
    }
    ready = sortedStrings2(nextReady);
  }
  if (seen.length !== ids2.length) {
    const cyclic = sortedStrings2([...indegree.entries()].filter(([, count]) => count > 0).map(([item]) => item));
    problems.push(`dependency cycle detected: ${cyclic.join(", ")}`);
  }
  return [layers, problems];
}
function dependencyClosure(nodes) {
  const byId = /* @__PURE__ */ new Map();
  for (const node of nodes) byId.set(nodeId(node), node);
  const memo = /* @__PURE__ */ new Map();
  const visit = (nid, stack) => {
    if (memo.has(nid)) return memo.get(nid);
    const active = new Set(stack ?? []);
    if (active.has(nid)) return /* @__PURE__ */ new Set();
    active.add(nid);
    const deps4 = /* @__PURE__ */ new Set();
    const node = byId.has(nid) ? byId.get(nid) : {};
    for (const dep of nodeDependsOn(node)) {
      if (byId.has(dep)) {
        deps4.add(dep);
        for (const item of visit(dep, active)) deps4.add(item);
      }
    }
    memo.set(nid, deps4);
    return deps4;
  };
  for (const nid of byId.keys()) visit(nid);
  return Object.fromEntries([...memo.entries()].map(([key, value]) => [key, sortedStrings2(value)]));
}
function budgetInt(value, label, errors) {
  if (value === null || value === void 0) return null;
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push(`budget.${label} must be a positive integer`);
    return null;
  }
  return value;
}
function forbiddenKindFields(nid, kind, node, fields, errors) {
  for (const field of fields) {
    if (Object.hasOwn(node, field)) errors.push(`node ${nid} kind=${kind} does not accept field: ${field}`);
  }
}
function checkTaskPayload(nid, node, validRoutes, errors) {
  if (Object.hasOwn(node, "command")) errors.push(`node ${nid} kind=task does not accept field: command`);
  if (!isRecord(node.seed)) errors.push(`node ${nid} requires seed object`);
  const routeId2 = nodeRouteId(node);
  let expandedSeed = null;
  if (!routeId2) {
    errors.push(`node ${nid} requires route_id`);
  } else if (!validRoutes.has(routeId2)) {
    errors.push(`node ${nid} references unknown route_id: ${routeId2}`);
  } else {
    try {
      expandedSeed = deps2.expandSeed(nodeSeedForStaticValidation(node));
    } catch (error) {
      errors.push(`node ${nid} seed is not dispatchable for ${routeId2}: ${String(error?.message ?? error)}`);
    }
  }
  for (const reducerError of nodeReducerErrors(node)) errors.push(`node ${nid} ${reducerError}`);
  const routeErrors = nodeRouteErrors(node);
  for (const routeError of routeErrors) errors.push(`node ${nid} ${routeError}`);
  const requestedRoute = nodeRoute(node);
  if (expandedSeed !== null && requestedRoute !== null && !routeErrors.length) {
    try {
      deps2.resolveRoleModelSelection(
        routeId2.split("__")[0],
        requestedRoute.model,
        requestedRoute.effort,
        routeId2.split("__").slice(1).join("__"),
        {
          pick: requestedRoute.pick,
          authorization: requestedRoute.authorization
        }
      );
    } catch (error) {
      errors.push(
        `node ${nid} route configuration resolution failed for ${routeId2}: ${String(error?.message ?? error)}; \u8BF7\u68C0\u67E5\u89D2\u8272\u914D\u7F6E\u6587\u4EF6\u3001\u89E3\u6790\u7ED3\u679C\u53CA\u89D2\u8272\u540D\uFF1B\u6A21\u578B\u5019\u9009\u4EC5\u4F9B\u9009\u578B\u53C2\u8003`
      );
    }
  }
  return routeId2;
}
function checkNode(index, node, manifest, ids2, validRoutes, errors, warnings) {
  let nid = nodeId(node);
  if (!nid) {
    errors.push(`nodes[${index}].id is required`);
    nid = `<missing-${index}>`;
  }
  if (ids2.has(nid)) errors.push(`duplicate node id: ${nid}`);
  ids2.add(nid);
  for (const field of sortedKeysMinus(node, ALLOWED_NODE_FIELDS)) {
    errors.push(`node ${nid} has unsupported field: ${field}`);
  }
  const kind = nodeKind(node);
  for (const kindError of nodeKindErrors(node)) errors.push(`node ${nid} ${kindError}`);
  let routeId2 = "";
  if (kind === "task") {
    routeId2 = checkTaskPayload(nid, node, validRoutes, errors);
  } else if (kind === "command") {
    forbiddenKindFields(nid, kind, node, COMMAND_FORBIDDEN_FIELDS, errors);
    for (const commandError of nodeCommandErrors(node)) errors.push(`node ${nid} ${commandError}`);
    if (nodeIsolation(node, manifest) === "worktree") {
      errors.push(`node ${nid} kind=command does not support worktree isolation`);
    }
  } else if (kind === "gate") {
    forbiddenKindFields(nid, kind, node, GATE_FORBIDDEN_FIELDS, errors);
    if (nodeIsolation(node, manifest) === "worktree") {
      errors.push(`node ${nid} kind=gate does not support worktree isolation`);
    }
  }
  for (const depError of nodeDependsOnErrors(node)) errors.push(`node ${nid} ${depError}`);
  if (kind !== "gate") {
    for (const artifactError of nodeDependencyArtifactErrors(node)) errors.push(`node ${nid} ${artifactError}`);
    for (const resourceError of nodeResourceLockErrors(node)) errors.push(`node ${nid} ${resourceError}`);
  }
  for (const policyError of nodeDependencyPolicyErrors(node)) errors.push(`node ${nid} ${policyError}`);
  for (const failureError of nodeFailurePolicyErrors(node)) errors.push(`node ${nid} ${failureError}`);
  const isolation = nodeIsolation(node, manifest);
  if (!ALLOWED_ISOLATION.has(isolation)) {
    errors.push(`node ${nid} isolation must be one of ${pyRepr(sortedStrings2(ALLOWED_ISOLATION))}`);
  }
  const writeScope = nodeWriteScope(node);
  if (writeScope.length && isolation === "read_only") {
    errors.push(`node ${nid} has write_scope but isolation=read_only`);
  }
  if (!writeScope.length && isolation === "worktree") {
    warnings.push(`node ${nid} uses worktree isolation without write_scope`);
  }
  const targetIsolation = nodeTargetIsolation(node, manifest);
  if (!ALLOWED_TARGET_ISOLATION.has(targetIsolation)) {
    errors.push(`node ${nid} target_isolation must be one of ${pyRepr(sortedStrings2(ALLOWED_TARGET_ISOLATION))}`);
  }
  const artifactWriteScopeRaw = nodeArtifactWriteScope(node);
  const artifactWriteScope = artifactWriteScopeRaw.length ? artifactWriteScopeRaw : writeScope;
  if (targetIsolation === "read_only") {
    for (const item of writeScope) {
      if (item.startsWith("external:")) {
        errors.push(`node ${nid} target_isolation=read_only but write_scope escapes control repo: ${item}`);
        continue;
      }
      if (!artifactWriteScope.some((prefix) => item === prefix || item.startsWith(`${prefix}/`))) {
        errors.push(`node ${nid} write_scope ${item} not under artifact_write_scope`);
      }
    }
  }
  const readLayers = nodeReadScopeLayers(node);
  const readScope = nodeReadScope(node);
  let entryScope;
  let preflightScope;
  let demoted;
  if (readLayers !== null) {
    entryScope = readLayers.entry;
    preflightScope = [...readLayers.entry, ...readLayers.index];
    demoted = new Set([...readLayers.index, ...readLayers.deferred].map((item) => normalizeConflictPath(item)));
  } else {
    entryScope = readScope;
    preflightScope = readScope;
    demoted = /* @__PURE__ */ new Set();
  }
  for (const raw of entryScope) {
    if (pathHitsBigDir(raw) && !demoted.has(normalizeConflictPath(raw))) {
      warnings.push(`node ${nid} read_scope entry hits large-dir pattern without index/deferred layer: ${raw}`);
    }
  }
  const preflight = deps2.computeScopePreflight(preflightScope);
  if (preflight.scope_preflight_warning) {
    warnings.push(`node ${nid}: ${preflight.scope_preflight_warning}`);
  }
  const role = nodeRole(node);
  const isScan = SCAN_ROLE_HINTS.some((hint) => role.toLowerCase().includes(hint));
  for (const text3 of nodeQuestionTexts(node)) {
    if (MULTI_QUESTION_CONNECTORS.some((conn) => text3.toLowerCase().includes(conn))) {
      warnings.push(
        `node ${nid} title/question contains multi-question connector; split into one-question slices: ${text3.slice(0, 60)}`
      );
      break;
    }
  }
  const row = {
    id: nid,
    kind,
    route_id: routeId2,
    role,
    depends_on: nodeDependsOn(node),
    dependency_artifacts: nodeDependencyArtifacts(node),
    dependency_policy: nodeDependencyPolicy(node),
    failure_policy: nodeFailurePolicy(node),
    resource_locks: nodeResourceLocks(node),
    is_reducer: nodeIsReducer(node),
    route: nodeRoute(node),
    route_source: nodeRouteSource(node),
    deferred_read_scope: Boolean(nodeDependencyArtifacts(node).length && !readScope.length),
    isolation,
    target_isolation: targetIsolation,
    read_scope: readScope,
    write_scope: writeScope,
    scope_preflight: preflight,
    is_scan: isScan
  };
  if (kind === "command") row.command = nodeCommand(node);
  return row;
}
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  for (const field of sortedKeysMinus(manifest, ALLOWED_TOP_LEVEL_FIELDS)) {
    errors.push(`unsupported manifest field: ${field}`);
  }
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  const defaults = Object.hasOwn(manifest, "defaults") ? manifest.defaults : {};
  if (!isRecord(defaults)) {
    errors.push("defaults must be an object");
  } else {
    for (const field of sortedKeysMinus(defaults, ALLOWED_DEFAULT_FIELDS)) {
      errors.push(`unsupported defaults field: ${field}`);
    }
  }
  const rawBudget = Object.hasOwn(manifest, "budget") ? manifest.budget : {};
  if (!isRecord(rawBudget)) {
    errors.push("budget must be an object");
  } else {
    for (const field of sortedKeysMinus(rawBudget, new Set(Object.keys(DEFAULT_BUDGET)))) {
      errors.push(`unsupported budget field: ${field}`);
    }
  }
  let rawReviewPolicy = Object.hasOwn(manifest, "review_policy") ? manifest.review_policy : {};
  if (!isRecord(rawReviewPolicy)) {
    errors.push("review_policy must be an object");
    rawReviewPolicy = {};
  } else {
    for (const field of sortedKeysMinus(rawReviewPolicy, new Set(Object.keys(DEFAULT_REVIEW_POLICY)))) {
      errors.push(`unsupported review_policy field: ${field}`);
    }
    const maxRounds = Object.hasOwn(rawReviewPolicy, "max_rounds") ? rawReviewPolicy.max_rounds : DEFAULT_REVIEW_POLICY.max_rounds;
    if (typeof maxRounds === "boolean" || typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds <= 0) {
      errors.push("review_policy.max_rounds must be a positive integer");
    }
  }
  let nodes;
  try {
    nodes = manifestNodes(manifest);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    errors.push(String(error.message));
    return {
      status: "failed",
      errors,
      warnings: [],
      nodes: [],
      layers: [],
      budget: effectiveBudget(manifest)
    };
  }
  const validRoutes = new Set(deps2.routesWithCards());
  const ids2 = /* @__PURE__ */ new Set();
  const nodeRows = [];
  nodes.forEach((node, index) => {
    nodeRows.push(checkNode(index, node, manifest, ids2, validRoutes, errors, warnings));
  });
  const [layers, dagProblems] = topologicalLayers(nodes);
  errors.push(...dagProblems);
  const scanCount = nodeRows.filter((row) => row.is_scan).length;
  const hasReduce = nodeRows.some((row) => row.is_reducer);
  if (scanCount >= 3 && !hasReduce) {
    warnings.push(
      `${scanCount} explorer/scan nodes without a reducer node; plan a reducer wave (mark that node reducer: true)`
    );
  }
  for (const row of nodeRows) {
    if (row.is_reducer) continue;
    if (REDUCE_HINTS.some((hint) => `${row.id} ${row.route_id}`.toLowerCase().includes(hint))) {
      warnings.push(
        `node ${row.id} reads as a reduce/synth step but is not marked reducer: true; mark it explicitly if it reduces`
      );
    }
  }
  const routeIds = new Set(nodeRows.filter((row) => row.route_id).map((row) => row.route_id));
  const roles = new Set(nodeRows.filter((row) => row.role).map((row) => row.role));
  if (nodeRows.length >= 2 && routeIds.size === 1 && roles.size && [...roles].every((role) => HIGH_TIER_ROLES.has(role))) {
    warnings.push(
      `all ${nodeRows.length} nodes share one high-tier route ${[...routeIds][0]}; diversify tiers or confirm max_high_tier_nodes`
    );
  }
  const closure = dependencyClosure(nodes);
  const rowsById = /* @__PURE__ */ Object.create(null);
  for (const row of nodeRows) rowsById[row.id] = row;
  for (let i = 0; i < nodeRows.length; i += 1) {
    const left = nodeRows[i];
    for (const right of nodeRows.slice(i + 1)) {
      const leftId = left.id;
      const rightId = right.id;
      const rightClosure = closure[rightId] ?? [];
      const leftClosure = closure[leftId] ?? [];
      if (rightClosure.includes(leftId) || leftClosure.includes(rightId)) continue;
      const hits = writeScopesConflict(left.write_scope, right.write_scope);
      if (hits.length) {
        const detail = hits.slice(0, 3).map(([a, b]) => `${a} <-> ${b}`).join(", ");
        warnings.push(`parallel write conflict between ${leftId} and ${rightId}; scheduler will serialize: ${detail}`);
      }
    }
  }
  const budget = effectiveBudget(manifest);
  const budgetFindings = (key) => isRecord(rawBudget) && Object.hasOwn(rawBudget, key) ? errors : warnings;
  const maxNodes = budgetInt(budget.max_nodes_total, "max_nodes_total", errors);
  if (maxNodes !== null && nodes.length > maxNodes) {
    budgetFindings("max_nodes_total").push(`node count ${nodes.length} exceeds budget.max_nodes_total ${maxNodes}`);
  }
  const maxHigh = budgetInt(budget.max_high_tier_nodes, "max_high_tier_nodes", errors);
  const highCount = nodeRows.filter((row) => HIGH_TIER_ROLES.has(row.role)).length;
  if (maxHigh !== null && highCount > maxHigh) {
    budgetFindings("max_high_tier_nodes").push(`high-tier node count ${highCount} exceeds budget.max_high_tier_nodes ${maxHigh}`);
  }
  budgetInt(budget.max_running_total, "max_running_total", errors);
  budgetInt(budget.max_submitted_per_tick, "max_submitted_per_tick", errors);
  let roleLimits = budget.max_running_by_role;
  if (!isRecord(roleLimits)) {
    errors.push("budget.max_running_by_role must be an object");
    roleLimits = {};
  }
  for (const [role, value] of Object.entries(roleLimits)) {
    budgetInt(value, `max_running_by_role.${role}`, errors);
  }
  const totalBytes = nodeRows.reduce((sum, row) => sum + Math.trunc(row.scope_preflight.scope_total_bytes || 0), 0);
  const totalFiles = nodeRows.reduce((sum, row) => sum + Math.trunc(row.scope_preflight.scope_file_count || 0), 0);
  const maxScopeBytes = budgetInt(budget.max_scope_bytes_total, "max_scope_bytes_total", errors);
  if (maxScopeBytes !== null && totalBytes > maxScopeBytes) {
    budgetFindings("max_scope_bytes_total").push(`scope bytes ${totalBytes} exceeds budget.max_scope_bytes_total ${maxScopeBytes}`);
  }
  return {
    status: errors.length ? "failed" : "ok",
    errors,
    warnings,
    nodes: nodeRows,
    layers,
    budget,
    review_policy: effectiveReviewPolicy(manifest),
    fleet_plan: {
      present: nodes.length >= 2,
      node_count: nodes.length,
      source: "manifest"
    },
    budget_usage: {
      nodes_total: nodes.length,
      high_tier_nodes: highCount,
      scope_file_count: totalFiles,
      scope_total_bytes: totalBytes
    },
    routes_checked: sortedStrings2(validRoutes),
    nodes_by_id: rowsById
  };
}
var deps2, ALLOWED_ISOLATION, ALLOWED_TARGET_ISOLATION, ALLOWED_DEPENDENCY_ARTIFACTS, ALLOWED_DEPENDENCY_POLICIES, ALLOWED_FAILURE_POLICIES, ALLOWED_EXECUTORS, ALLOWED_ROUTE_FIELDS, ROUTE_STRING_FIELDS, ROUTE_SELECTORS, ALLOWED_NODE_KINDS, ALLOWED_COMMAND_FIELDS, COMMAND_DEFAULT_TIMEOUT_SECONDS, COMMAND_MAX_TIMEOUT_SECONDS, GATE_FORBIDDEN_FIELDS, COMMAND_FORBIDDEN_FIELDS, EXPLICIT_ROUTE_SOURCE, LEGACY_ROUTE_SOURCE, MANIFEST_SCHEMA_VERSION, HIGH_TIER_ROLES, BIG_DIR_NAMES, MULTI_QUESTION_CONNECTORS, SCAN_ROLE_HINTS, REDUCE_HINTS, DEFAULT_BUDGET, DEFAULT_REVIEW_POLICY, ALLOWED_TOP_LEVEL_FIELDS, ALLOWED_DEFAULT_FIELDS, ALLOWED_NODE_FIELDS;
var init_fleet_manifest_check = __esm({
  async "ops/tools/dispatch-core/fleet_manifest_check.mjs"() {
    init_tool_common();
    init_model_selection();
    init_py();
    await init_dispatch_prepare();
    init_seed_minimal();
    deps2 = {
      computeScopePreflight,
      resolveRoleModelSelection,
      expandSeed,
      routesWithCards
    };
    ALLOWED_ISOLATION = /* @__PURE__ */ new Set(["read_only", "same_tree_locked", "worktree"]);
    ALLOWED_TARGET_ISOLATION = /* @__PURE__ */ new Set(["read_only", "writable"]);
    ALLOWED_DEPENDENCY_ARTIFACTS = /* @__PURE__ */ new Set(["report", "handoff"]);
    ALLOWED_DEPENDENCY_POLICIES = /* @__PURE__ */ new Set(["all_succeeded", "all_settled"]);
    ALLOWED_FAILURE_POLICIES = /* @__PURE__ */ new Set(["success_only", "all_settled"]);
    ALLOWED_EXECUTORS = /* @__PURE__ */ new Set(["pi"]);
    ALLOWED_ROUTE_FIELDS = /* @__PURE__ */ new Set(["executor", "model", "effort", "pick", "authorization"]);
    ROUTE_STRING_FIELDS = /* @__PURE__ */ new Set(["executor", "model", "effort", "pick"]);
    ROUTE_SELECTORS = ["pick", "model"];
    ALLOWED_NODE_KINDS = /* @__PURE__ */ new Set(["task", "command", "gate"]);
    ALLOWED_COMMAND_FIELDS = /* @__PURE__ */ new Set(["argv", "cwd", "timeout_seconds"]);
    COMMAND_DEFAULT_TIMEOUT_SECONDS = 600;
    COMMAND_MAX_TIMEOUT_SECONDS = 3600;
    GATE_FORBIDDEN_FIELDS = [
      "seed",
      "route",
      "command",
      "reducer",
      "write_scope",
      "write_domains",
      "artifact_write_scope",
      "resource_locks",
      "dependency_artifacts"
    ];
    COMMAND_FORBIDDEN_FIELDS = ["seed", "route", "reducer"];
    EXPLICIT_ROUTE_SOURCE = "manifest";
    LEGACY_ROUTE_SOURCE = "agent_config";
    MANIFEST_SCHEMA_VERSION = 2;
    HIGH_TIER_ROLES = /* @__PURE__ */ new Set(["executor-agent", "verify-agent", "plan-checker", "planner-agent"]);
    BIG_DIR_NAMES = /* @__PURE__ */ new Set(["runs", "outputs", ".runtime", "node_modules", ".venv", "dist"]);
    MULTI_QUESTION_CONNECTORS = ["\u548C", "\u4E0E", "\u4EE5\u53CA", "\u540C\u65F6", "plus", "and also"];
    SCAN_ROLE_HINTS = ["explorer", "scan"];
    REDUCE_HINTS = ["reduce", "synth"];
    DEFAULT_BUDGET = {
      max_nodes_total: 30,
      max_running_total: 8,
      max_submitted_per_tick: 8,
      max_high_tier_nodes: 4,
      max_scope_bytes_total: 50 * 1024 * 1024,
      max_running_by_role: {}
    };
    DEFAULT_REVIEW_POLICY = { max_rounds: 2 };
    ALLOWED_TOP_LEVEL_FIELDS = /* @__PURE__ */ new Set([
      "schema_version",
      "run_id",
      "defaults",
      "budget",
      "review_policy",
      "nodes"
    ]);
    ALLOWED_DEFAULT_FIELDS = /* @__PURE__ */ new Set(["isolation", "target_isolation"]);
    ALLOWED_NODE_FIELDS = /* @__PURE__ */ new Set([
      "id",
      "kind",
      "depends_on",
      "dependency_artifacts",
      "dependency_policy",
      "seed",
      "command",
      "isolation",
      "target_isolation",
      "write_scope",
      "write_domains",
      "resource_locks",
      "failure_policy",
      "reducer",
      "artifact_write_scope",
      "route"
    ]);
  }
});

// ops/tools/dispatch-core/fleet_scheduler.mjs
import { spawn as spawn2 } from "node:child_process";
import {
  closeSync as closeSync5,
  existsSync as existsSync9,
  mkdirSync as mkdirSync8,
  openSync as openSync5,
  readFileSync as readFileSync10,
  readdirSync as readdirSync7,
  rmSync as rmSync4,
  statSync as statSync10,
  writeFileSync as writeFileSync6
} from "node:fs";
import path16 from "node:path";
import { uptime } from "node:os";
import process8 from "node:process";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
function sleepSeconds(seconds) {
  const ms = Math.max(0, Number(seconds) * 1e3);
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function monotonicSeconds() {
  return Number(process8.hrtime.bigint()) / 1e9;
}
function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot convert float infinity to integer");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text3 = pyStrip(value);
    if (!/^[+-]?\d+$/.test(text3)) throw new TypeError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
    return Number.parseInt(text3, 10);
  }
  throw new TypeError(`int() argument must be a string or a number, not '${typeof value}'`);
}
function notEmptyPy(value) {
  if (value === null || value === void 0) return false;
  if (value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}
function pyDictEqual(left, right) {
  return JSON.stringify(canonicalValue(left ?? null)) === JSON.stringify(canonicalValue(right ?? null));
}
function dedupe(items) {
  return [...new Set(items)];
}
function parseIsoMs(raw) {
  const text3 = String(raw).replace("Z", "+00:00");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text3)) return null;
  const hasZone = /(?:[+-]\d{2}:?\d{2})$/.test(text3);
  const value = Date.parse(hasZone ? text3 : `${text3}Z`);
  return Number.isFinite(value) ? value : null;
}
function isDir(target) {
  try {
    return statSync10(target).isDirectory();
  } catch {
    return false;
  }
}
function isFile4(target) {
  try {
    return statSync10(target).isFile();
  } catch {
    return false;
  }
}
function resolveUnder(value, base) {
  return pyResolveUnder(pyStr(value), base);
}
function utcAfter(seconds) {
  const now = utcNow();
  const match = /^(.*?)(?:\.(\d{1,6}))?\+00:00$/.exec(now);
  const base = Date.parse(`${match[1]}Z`) + Number(seconds) * 1e3;
  const fraction = match[2] ? `.${match[2]}` : "";
  return `${new Date(base).toISOString().slice(0, 19)}${fraction}+00:00`;
}
function livenessCheckDue(node) {
  const raw = pyStr(node.next_liveness_check_at || "");
  if (!raw) return true;
  const due = parseIsoMs(raw);
  if (due === null) return true;
  return due <= clock.now().getTime();
}
function deferLivenessCheck(node, seconds = LIVENESS_RECHECK_SECONDS) {
  node.next_liveness_check_at = utcAfter(seconds);
  return null;
}
function safeId(value) {
  const cleaned = pyStripChars2(pyStrip(pyStr(value)).replace(SAFE_ID_RE, "-"), ".-");
  return cleaned || "fleet-run";
}
function pyStripChars2(text3, chars) {
  let start = 0;
  let end = text3.length;
  while (start < end && chars.includes(text3[start])) start += 1;
  while (end > start && chars.includes(text3[end - 1])) end -= 1;
  return text3.slice(start, end);
}
function writeJson2(target, data) {
  mkdirSync8(path16.dirname(target), { recursive: true });
  writeFileSync6(target, `${canonicalJson(data)}
`, "utf8");
  return null;
}
function requireRepoInternal(target, label) {
  const resolved = resolveLikePython(target);
  const root = resolveLikePython(ROOT);
  if (!pyIsRelativeTo(resolved, root)) {
    throw new ToolError(`${label} must stay under repo root: ${resolved}`);
  }
  return resolved;
}
function stateRoot(value) {
  const resolved = value ? pyResolveUnder(pyStr(value), ROOT) : resolveLikePython(DEFAULT_STATE_ROOT);
  return requireRepoInternal(resolved, "state root");
}
function runDir(root, runId) {
  return path16.join(pyStr(root), safeId(runId));
}
function statePath(root, runId) {
  return path16.join(runDir(root, runId), "state.json");
}
function manifestSnapshotPath(root, runId) {
  return path16.join(runDir(root, runId), "manifest.json");
}
function seedPath(root, runId, nodeIdValue) {
  return path16.join(runDir(root, runId), "seeds", `${safeId(nodeIdValue)}.json`);
}
function dependencyResultIndexPath(root, runId, nodeIdValue) {
  return path16.join(runDir(root, runId), "dependency-results", `${safeId(nodeIdValue)}.json`);
}
function driverStatusPath(root, runId) {
  return path16.join(runDir(root, runId), "driver.json");
}
function driverLogPath(root, runId) {
  return path16.join(runDir(root, runId), "driver.log");
}
function runLockPath(root, runId) {
  return path16.join(runDir(root, runId), "scheduler.lock");
}
function runMutationLock(root, runId, fn, { timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS } = {}) {
  const lock = acquireRunLock(root, runId, timeoutSeconds);
  try {
    const result = fn();
    if (result != null && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => releaseRunLock(lock));
    }
    releaseRunLock(lock);
    return result;
  } catch (error) {
    releaseRunLock(lock);
    throw error;
  }
}
function acquireRunLock(root, runId, timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS) {
  const target = runLockPath(root, runId);
  mkdirSync8(path16.dirname(target), { recursive: true });
  const deadline = deps3.monotonic() + Math.max(0, timeoutSeconds);
  for (; ; ) {
    const lock = tryFileLock(target);
    if (lock) return lock;
    if (deps3.monotonic() >= deadline) throw new ToolError(`fleet run mutation lock busy: ${runId}`);
    deps3.sleep(0.05);
  }
}
async function acquireRunLockAsync(root, runId, timeoutSeconds = RUN_LOCK_TIMEOUT_SECONDS) {
  const target = runLockPath(root, runId);
  mkdirSync8(path16.dirname(target), { recursive: true });
  const deadline = deps3.monotonic() + Math.max(0, timeoutSeconds);
  for (; ; ) {
    const lock = tryFileLock(target);
    if (lock) return lock;
    if (deps3.monotonic() >= deadline) throw new ToolError(`fleet run mutation lock busy: ${runId}`);
    await delay(50);
  }
}
function releaseRunLock(lock) {
  lock.release();
  return null;
}
function processAliveImpl(pid) {
  let value;
  try {
    value = pyInt(pid);
  } catch {
    return false;
  }
  if (value <= 0) return false;
  try {
    process8.kill(value, 0);
  } catch {
    return false;
  }
  return true;
}
function newRouteRecord(requested, source) {
  return {
    source,
    requested: requested ? deepCopy2(requested) : null,
    frozen: null,
    actual: null,
    identity_evidence: null,
    usage: { provenance: null, token_usage: null }
  };
}
function ensureRouteRecord(node) {
  let record2 = node.route;
  if (!isRecord(record2) || !Object.hasOwn(record2, "requested")) {
    record2 = newRouteRecord(
      isRecord(node.requested_route) ? node.requested_route : null,
      pyStr(node.route_source || "agent_config")
    );
    node.route = record2;
  }
  if (!Object.hasOwn(record2, "source")) record2.source = pyStr(node.route_source || "agent_config");
  if (!Object.hasOwn(record2, "actual")) record2.actual = null;
  if (!Object.hasOwn(record2, "frozen")) record2.frozen = null;
  let usage = record2.usage;
  if (!isRecord(usage)) {
    usage = {};
    record2.usage = usage;
  }
  if (!Object.hasOwn(usage, "provenance")) usage.provenance = null;
  if (!Object.hasOwn(usage, "token_usage")) usage.token_usage = null;
  if (record2.identity_evidence !== null && record2.identity_evidence !== void 0 && !isRecord(record2.identity_evidence)) {
    record2.identity_evidence = null;
  }
  node.route_source = record2.source;
  node.requested_route = deepCopy2(record2.requested ?? null);
  node.actual_route = deepCopy2(record2.actual ?? null);
  delete node.fallback;
  node.usage_provenance = usage.provenance ?? null;
  return record2;
}
function routeSnapshot(node) {
  return deepCopy2(ensureRouteRecord(node));
}
function frozenRequestedRoute(node) {
  const requested = ensureRouteRecord(node).requested;
  return isRecord(requested) ? deepCopy2(requested) : null;
}
function routeFromPayload(payload) {
  let nested = {};
  for (const key of ["actual_route", "actual", "route"]) {
    const value = payload[key];
    if (isRecord(value)) {
      nested = value;
      break;
    }
  }
  const values = {};
  const aliases = {
    executor: ["actual_executor", "executor"],
    model: ["actual_model", "model"],
    effort: ["actual_effort", "effort"]
  };
  for (const [key, names] of Object.entries(aliases)) {
    let value = null;
    for (const name of [key, ...names]) {
      const candidate = nested[name];
      if (notEmptyValue(candidate)) {
        value = candidate;
        break;
      }
    }
    if (!notEmptyValue(value)) {
      value = null;
      for (const name of names) {
        const candidate = payload[name];
        if (notEmptyValue(candidate)) {
          value = candidate;
          break;
        }
      }
    }
    if (notEmptyValue(value)) values[key] = pyStr(value);
  }
  if (!Object.keys(values).length) return null;
  const result = {};
  for (const key of ROUTE_KEYS) result[key] = Object.hasOwn(values, key) ? values[key] : null;
  if (Object.hasOwn(nested, "provider") || Object.hasOwn(payload, "provider")) {
    result.provider = Object.hasOwn(nested, "provider") ? nested.provider : payload.provider;
  }
  return result;
}
function notEmptyValue(value) {
  return value !== null && value !== void 0 && value !== "";
}
function updateRouteFromPayload(node, payload, source) {
  const record2 = ensureRouteRecord(node);
  const actual = routeFromPayload(payload);
  if (actual) {
    const previous = isRecord(record2.actual) ? record2.actual : {};
    record2.actual = { ...previous, ...actual, source };
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const usageProvenance = payload.usage_provenance || usage.provenance;
  if (notEmptyValue(usageProvenance)) record2.usage.provenance = pyStr(usageProvenance);
  ensureRouteRecord(node);
  return null;
}
function routeMatchesManifest(node, manifestNode) {
  const record2 = ensureRouteRecord(node);
  return record2.source === nodeRouteSource(manifestNode) && pyDictEqual(record2.requested ?? null, nodeRoute(manifestNode));
}
function normalizeDispatchOverrides(contextMode = "") {
  const context = pyStrip(pyStr(contextMode || ""));
  if (context && !["isolated", "project-aware"].includes(context)) {
    throw new ToolError(`unsupported async context mode: ${context}`);
  }
  return context ? { context_mode: context } : {};
}
function createInitialState(manifest, manifestPath, runId, root, dispatchOverrides = null) {
  const nodes = [];
  for (const node of Array.isArray(manifest.nodes) ? manifest.nodes : []) {
    if (!isRecord(node)) continue;
    const nid = nodeId(node);
    const requestedRoute = nodeRoute(node);
    const routeSource = nodeRouteSource(node);
    const routeRecord = newRouteRecord(requestedRoute, routeSource);
    const seed = nodeSeed(node);
    nodes.push({
      id: nid,
      kind: nodeKind(node),
      command_spec: nodeKind(node) === "command" ? nodeCommand(node) : null,
      state: "pending",
      route_id: Object.hasOwn(seed, "route_id") ? seed.route_id : Object.hasOwn(node, "route_id") ? node.route_id : "",
      role: nodeRole(node),
      route: routeRecord,
      route_source: routeSource,
      requested_route: deepCopy2(requestedRoute),
      actual_route: null,
      usage_provenance: null,
      depends_on: nodeDependsOn(node),
      dependency_policy: nodeDependencyPolicy(node),
      failure_policy: nodeFailurePolicy(node),
      resource_locks: nodeResourceLocks(node),
      is_reducer: nodeIsReducer(node),
      isolation: nodeIsolation(node, manifest),
      write_scope: nodeWriteScope(node),
      task_id: null,
      task_root: pyStr(DEFAULT_ASYNC_TASK_ROOT),
      worktree_path: null,
      dispatch: null,
      last_status: null,
      review_required: false,
      review_decision: null,
      review: null,
      review_round: 0,
      review_history: [],
      revision: 0,
      updated_at: utcNow()
    });
  }
  return {
    run_state_schema_version: 1,
    run_id: runId,
    created_at: utcNow(),
    updated_at: utcNow(),
    repo_root: pyStr(ROOT),
    manifest_source: pyStr(manifestPath),
    manifest_snapshot: pyStr(manifestSnapshotPath(root, runId)),
    state_root: pyStr(root),
    budget: effectiveBudget(manifest),
    review_policy: effectiveReviewPolicy(manifest),
    dispatch_overrides: { ...dispatchOverrides || {} },
    run_state: "created",
    revision: 0,
    event_revision: 0,
    ready_queue: [],
    ready_queue_revision: 0,
    failure_fuse: { status: "open", blocked_nodes: [] },
    fleet_settled_emitted: false,
    nodes,
    events: []
  };
}
function indexNodes(state) {
  const out = /* @__PURE__ */ Object.create(null);
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (isRecord(node)) out[node.id] = node;
  }
  return out;
}
function positiveInt(value, fallback = 0) {
  let parsed;
  try {
    parsed = pyInt(value);
  } catch {
    return fallback;
  }
  return parsed >= 0 ? parsed : fallback;
}
function appendFleetEvent(state, eventType, node = null, options = {}) {
  const { businessState = null, incrementNodeRevision = true, ...details } = options;
  if (node !== null && incrementNodeRevision) {
    node.revision = positiveInt(node.revision) + 1;
  }
  state.revision = positiveInt(state.revision) + 1;
  const timestamp = utcNow();
  const nodeState = pyStr(node !== null ? node.state : state.run_state || "unknown");
  const business = businessState || (Object.hasOwn(BUSINESS_STATE_BY_NODE_STATE, nodeState) ? BUSINESS_STATE_BY_NODE_STATE[nodeState] : nodeState);
  const cursorRevision = positiveInt(state.event_revision) + 1;
  state.event_revision = cursorRevision;
  const event = {
    at: timestamp,
    timestamp,
    type: eventType,
    run_id: pyStr(state.run_id || ""),
    node_id: node !== null ? pyStr(node.id || "") : "",
    task_id: node !== null ? node.task_id ?? null : null,
    revision: node !== null ? positiveInt(node.revision) : positiveInt(state.revision),
    node_revision: node !== null ? positiveInt(node.revision) : null,
    fleet_revision: cursorRevision,
    cursor: `${state.run_id}+${cursorRevision}`,
    state: nodeState,
    business_state: business,
    ...details
  };
  let events = state.events;
  if (!Array.isArray(events)) {
    events = [];
    state.events = events;
  }
  events.push(event);
  if (events.length > 200) events.splice(0, events.length - 200);
  return event;
}
function setNodeState(state, node, nodeState, options = {}) {
  const { eventType = "agent_progress", businessState = null, ...details } = options;
  const before = pyStr(node.state || "");
  node.state = nodeState;
  node.updated_at = utcNow();
  if (before !== nodeState || ["agent_started", "agent_settled", "reducer_settled"].includes(eventType)) {
    appendFleetEvent(state, eventType, node, { businessState, ...details });
  }
  return before !== nodeState;
}
function setFailureFuse(state, { nodeIdValue, reason, blocker = null } = {}) {
  let fuse = state.failure_fuse;
  if (!isRecord(fuse)) {
    fuse = {};
    state.failure_fuse = fuse;
  }
  fuse.status = "tripped";
  fuse.reason = reason;
  fuse.tripped_by = blocker || nodeIdValue;
  if (!Object.hasOwn(fuse, "blocked_nodes")) fuse.blocked_nodes = [];
  const blockedNodes = fuse.blocked_nodes;
  if (Array.isArray(blockedNodes) && !blockedNodes.includes(nodeIdValue)) blockedNodes.push(nodeIdValue);
  return null;
}
function rebuildReadyQueue(state, manifestNodesList, { preserveExisting = true } = {}) {
  const byId = indexNodes(state);
  const [layers] = topologicalLayers(manifestNodesList);
  const criticality = downstreamCounts(manifestNodesList);
  const layerIndex = /* @__PURE__ */ Object.create(null);
  layers.forEach((layer, index) => {
    for (const nid of layer) layerIndex[nid] = index;
  });
  const existing = preserveExisting ? state.ready_queue : [];
  const existingIds = Array.isArray(existing) ? existing.map((item) => pyStr(item)) : [];
  const candidates = /* @__PURE__ */ new Set();
  for (const [nid, node] of Object.entries(byId)) {
    if (node.state === "pending" && dependenciesReady(node, byId)) candidates.add(pyStr(nid));
  }
  const ordered = existingIds.filter((nid) => candidates.has(nid));
  for (const nid of candidates) {
    if (!ordered.includes(nid)) ordered.push(nid);
  }
  ordered.sort((left, right) => {
    const leftKey = [-(criticality[left] ?? 0), layerIndex[left] ?? 0, left];
    const rightKey = [-(criticality[right] ?? 0), layerIndex[right] ?? 0, right];
    for (let i = 0; i < 3; i += 1) {
      if (leftKey[i] < rightKey[i]) return -1;
      if (leftKey[i] > rightKey[i]) return 1;
    }
    return 0;
  });
  state.ready_queue = ordered;
  state.ready_queue_revision = positiveInt(state.revision);
  return ordered;
}
function startRun(manifestFile, runIdArg, root, force, dispatchOverrides = null) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const manifest = loadManifest(manifestFile);
  const validation = validateManifest(manifest);
  if (validation.status !== "ok") {
    throw new ToolError(`fleet manifest failed validation: ${validation.errors.join("; ")}`);
  }
  const stem = path16.basename(pyStr(manifestFile)).replace(/\.[^.\\/]*$/, "");
  const runId = safeId(runIdArg || pyStr(manifest.run_id || stem));
  const directory = runDir(resolvedRoot, runId);
  if (existsSync9(directory) && !force) throw new ToolError(`fleet run already exists: ${rel(directory)}`);
  if (existsSync9(cancellationPath(resolvedRoot, runId))) throw new ToolError("cancelled fleet records are retained; use a new run_id");
  if (existsSync9(directory) && force) rmSync4(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  mkdirSync8(directory, { recursive: true });
  writeJson2(manifestSnapshotPath(resolvedRoot, runId), manifest);
  const state = createInitialState(
    manifest,
    resolveLikePython(manifestFile),
    runId,
    resolvedRoot,
    dispatchOverrides
  );
  state.run_state = "running";
  appendFleetEvent(state, "fleet_started", null, {
    businessState: "running",
    incrementNodeRevision: false,
    manifest: pyStr(manifestFile)
  });
  rebuildReadyQueue(state, Array.isArray(manifest.nodes) ? [...manifest.nodes] : [], { preserveExisting: false });
  writeJson2(statePath(resolvedRoot, runId), state);
  return {
    status: "ok",
    run_id: runId,
    state_path: rel(statePath(resolvedRoot, runId)),
    nodes: state.nodes.length
  };
}
function runCommandImpl(cmd, cwd, { stdin = null, timeout = 60 } = {}) {
  const argv = cmd.map((item) => pyStr(item));
  const proc = pySpawnSync(argv[0], argv.slice(1), {
    cwd: pyStr(cwd),
    input: stdin === null || stdin === void 0 ? void 0 : String(stdin),
    encoding: "utf8",
    timeout: timeout * 1e3,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024
  });
  if (proc.error) {
    if (proc.error.code === "ENOENT") throw new ToolError(`command not found: ${argv[0]}`);
    if (proc.error.code === "ETIMEDOUT") throw new ToolError(`command timed out: ${argv.join(" ")}`);
    throw new ToolError(`command failed to start: ${proc.error.message}`);
  }
  if (proc.signal && proc.status === null) throw new ToolError(`command timed out: ${argv.join(" ")}`);
  return {
    cmd: argv,
    exit_code: proc.status ?? 1,
    stdout: pyStr(proc.stdout ?? ""),
    stderr: pyStr(proc.stderr ?? "")
  };
}
function parseJsonStdout(result, label) {
  const text3 = pyStrip(pyStr(result.stdout || ""));
  if (!text3) throw new ToolError(`${label} returned empty stdout: ${pyStr(result.stderr ?? "").slice(0, 400)}`);
  let data;
  try {
    data = pyJsonLoads(text3);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`${label} returned invalid JSON: ${text3.slice(0, 600)}`);
  }
  if (!isRecord(data)) throw new ToolError(`${label} JSON root is not object`);
  return data;
}
function nodeTaskRoot(state, node) {
  const defaultRoot = path16.join(runDir(pyStr(state.state_root), pyStr(state.run_id)), "async_tasks");
  return pyStr(node.task_root || defaultRoot);
}
function asyncCompletionInbox(taskRoot) {
  return path16.join(path16.dirname(resolveLikePython(taskRoot)), "async_inbox");
}
function runtimeTaskDir(node) {
  const lastStatus = isRecord(node.last_status) ? node.last_status : {};
  const dispatch = isRecord(node.dispatch) ? node.dispatch : {};
  const candidates = [lastStatus.task_dir, dispatch.task_dir];
  const taskRoot = node.task_root;
  const taskId = node.task_id;
  if (taskRoot && taskId) candidates.push(pathlibJoin(pyStr(taskRoot), pyStr(taskId)));
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !pyStrip(candidate)) continue;
    const resolved = pyResolveUnder(candidate, ROOT);
    if (isDir(resolved)) return resolved;
  }
  return null;
}
function readBoundedRuntimeJson(target) {
  try {
    if (!isFile4(target) || statSync10(target).size > MAX_RUNTIME_EVIDENCE_BYTES) return null;
    const raw = readFileSync10(target);
    if (raw.length > MAX_RUNTIME_EVIDENCE_BYTES) return null;
    const data = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}
function readTerminalRuntimeArtifacts(node) {
  const taskDir = runtimeTaskDir(node);
  if (taskDir === null) return {};
  const artifacts = {};
  for (const name of ["status.json", "child-task-live.json", "child-task-result.json"]) {
    const target = resolveLikePython(path16.join(taskDir, name));
    if (!pySamePath(path16.dirname(target), taskDir)) continue;
    const data = readBoundedRuntimeJson(target);
    if (data !== null) artifacts[name] = data;
  }
  return artifacts;
}
function runtimeIdentityEvidence(node, childResult) {
  const selection = isRecord(childResult.selection) ? childResult.selection : {};
  const turnRequested = isRecord(selection.turnRequested) ? selection.turnRequested : {};
  const turn = isRecord(childResult.turn) ? childResult.turn : {};
  const requestedModel = turn.requestedModel || turnRequested.model;
  const requestedEffort = turn.requestedEffort || turnRequested.effort;
  if (typeof requestedModel !== "string" || !pyStrip(requestedModel)) return null;
  if (typeof requestedEffort !== "string" || !pyStrip(requestedEffort)) return null;
  const frozen2 = frozenRequestedRoute(node);
  if (!frozen2) return null;
  if (requestedModel !== (frozen2.model ?? void 0) || requestedEffort !== (frozen2.effort ?? void 0)) return null;
  const thread = isRecord(childResult.thread) ? childResult.thread : {};
  const response = isRecord(thread.response) ? thread.response : {};
  const provider = response.modelProvider;
  if (typeof provider !== "string" || !pyStrip(provider)) return null;
  return {
    source: "child-task-result.json",
    request_observed: true,
    requested_model: requestedModel,
    requested_effort: requestedEffort,
    provider,
    provider_backend_attestation: "unavailable"
  };
}
function runtimeTokenUsage(live) {
  const usage = live.token_usage;
  if (!isRecord(usage) || !Object.hasOwn(usage, "total_tokens")) return null;
  const projected = {};
  for (const key of RUNTIME_USAGE_FIELDS) {
    const value = usage[key];
    if (value === null || value === void 0) continue;
    if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) return null;
    if (value < 0 || value > MAX_RUNTIME_USAGE_VALUE) return null;
    projected[key] = value;
  }
  if (!Object.hasOwn(projected, "total_tokens")) return null;
  return projected;
}
function enrichTerminalRouteFromRuntime(node) {
  const record2 = ensureRouteRecord(node);
  const before = deepCopy2(record2);
  const artifacts = readTerminalRuntimeArtifacts(node);
  const childResult = artifacts["child-task-result.json"];
  if (childResult) {
    const identity = runtimeIdentityEvidence(node, childResult);
    if (identity && (record2.identity_evidence === null || record2.identity_evidence === void 0)) {
      record2.identity_evidence = identity;
    }
  }
  const live = artifacts["child-task-live.json"];
  const tokenUsage = live ? runtimeTokenUsage(live) : null;
  if (tokenUsage !== null && (record2.usage.token_usage === null || record2.usage.token_usage === void 0)) {
    record2.usage.token_usage = tokenUsage;
    record2.usage.provenance = "child-task-live.json";
  }
  ensureRouteRecord(node);
  return !pyDictEqual(before, record2);
}
function requiresSafetyReview(status) {
  const mechanical = status.mechanical_summary || {};
  return status.safety_review === true || status.retained_worker === true || status.cleanup?.tree_confirmed === false || status.write_domain_scope_compliant === false || mechanical.write_domain_scope_compliant === false || status.write_domain_violation_count > 0 || /identity|write_domain|write_scope|write_claim|cleanup_failed|retained_worker/.test(
    `${status.failure_type || ""} ${status.contract_state || ""}`
  );
}
function applyAsyncStatus(node, status, source, fleetState = null) {
  const currentTaskId = pyStr(node.task_id || "");
  const receiptTaskId = pyStr(status.task_id || "");
  if (receiptTaskId && receiptTaskId !== currentTaskId) return false;
  if (currentTaskId && !receiptTaskId) return false;
  if (currentTaskId) {
    const boundTaskId = pyStr(node.receipt_task_id || "");
    if (boundTaskId && boundTaskId !== currentTaskId) return false;
    node.receipt_task_id = currentTaskId;
  }
  const before = node.state;
  if (ASYNC_TERMINAL_STATES.has(status.state)) {
    const runtimeStatus = readTerminalRuntimeArtifacts({ ...node, last_status: status })["status.json"];
    if (runtimeStatus?.task_id === currentTaskId && runtimeStatus.retained_worker === true) {
      status = { ...status, retained_worker: true };
    }
  }
  node.resource_quarantined = status.retained_worker === true || status.cleanup?.tree_confirmed === false;
  updateRouteFromPayload(node, status, source);
  node.last_status = { ...status, source };
  const rawState = status.state;
  const requiresParentReview = Boolean(status.requires_parent_review || status.review_gate === "needs_parent_review");
  const cancelReason = pyStr(status.cancel_reason || "");
  const userCancel = cancelReason === "user_requested" || node.cancel_reason === "user_requested" || status.review_gate === "cancelled";
  if (rawState === "paused") {
    node.state = "paused";
  } else if (ACTIVE_STATES.has(rawState)) {
    node.state = rawState;
  } else if (["done", "failed", "cancelled"].includes(rawState) && (node.kind === "gate" || requiresSafetyReview(status))) {
    node.state = "needs_parent_review";
    node.review_required = true;
    if (!["accepted", "blocked", "requeued"].includes(node.review_decision)) node.review_decision = "pending";
  } else if (["done", "failed", "cancelled"].includes(rawState)) {
    node.state = rawState === "cancelled" && userCancel ? "cancelled" : requiresParentReview || rawState === "failed" || rawState === "cancelled" && !userCancel || ["partial", "unknown", "blocked", "failed"].includes(status.business_state) ? "failed" : rawState;
    node.review_required = false;
    node.review_decision = null;
  }
  node.updated_at = utcNow();
  if (TERMINAL_STATES.has(node.state)) enrichTerminalRouteFromRuntime(node);
  const changed = before !== node.state;
  if (fleetState !== null && fleetState !== void 0) {
    const terminal = TERMINAL_STATES.has(node.state);
    const eventType = terminal && node.is_reducer ? "reducer_settled" : terminal ? "agent_settled" : "agent_progress";
    appendFleetEvent(fleetState, eventType, node, {
      businessState: pyStr(status.business_state || "") || null,
      source,
      changed,
      route: routeSnapshot(node),
      error: status.error || status.failure_type || null,
      attention_required: node.state === "failed" || node.state === "cancel_requested"
    });
  }
  return changed;
}
function readCompletionNotices(taskRoot, taskIds) {
  const wanted = taskIds instanceof Set ? taskIds : new Set(taskIds);
  const inbox = asyncCompletionInbox(taskRoot);
  if (!existsSync9(inbox)) return [/* @__PURE__ */ Object.create(null), []];
  const notices = /* @__PURE__ */ Object.create(null);
  const errors = [];
  const names = sortedStrings2(readdirSync7(inbox).filter((name) => name.endsWith(".json")));
  for (const name of names) {
    if (name.endsWith(".stall.json") || name.endsWith(".attention.json")) continue;
    const noticePath = path16.join(inbox, name);
    let notice;
    try {
      notice = pyJsonLoads(pyReadText(noticePath));
    } catch (error) {
      if (error?.name !== "JSONDecodeError") throw error;
      const lineno = Number(/line (\d+) column/.exec(String(error.message))?.[1] ?? 1);
      errors.push(`invalid completion notice ${rel(noticePath)}:${lineno}`);
      continue;
    }
    if (!isRecord(notice)) {
      errors.push(`completion notice root must be object: ${rel(noticePath)}`);
      continue;
    }
    const stem = name.replace(/\.[^.]*$/, "");
    const taskId = pyStr(notice.task_id || stem);
    if (wanted.has(taskId)) notices[taskId] = { completion_notice_path: noticePath, ...notice };
  }
  return [notices, errors];
}
function compactCompletionNotice(notice) {
  const data = {};
  for (const key of [
    "task_id",
    "state",
    "requires_parent_review",
    "contract_state",
    "business_state",
    "failure_type",
    "turn_status",
    "exit_code",
    "signal",
    "error",
    "report_path",
    "handoff_path",
    "completion_notice_path"
  ]) {
    const value = notice[key];
    if (!notEmptyPy(value)) continue;
    data[key] = key === "error" && typeof value === "string" ? value.slice(0, 300) : value;
  }
  return data;
}
function waitForCompletionNotices(state, waitMs, { pollIntervalMs = 250 } = {}) {
  if (waitMs < 0 || waitMs > 6e5) throw new ToolError("wait_ms must be between 0 and 600000");
  const activeNodes = (Array.isArray(state.nodes) ? state.nodes : []).filter(
    (node) => isRecord(node) && node.task_id && ACTIVE_STATES.has(node.state)
  );
  if (!activeNodes.length) {
    return {
      status: "ok",
      event: "no_active_tasks",
      active: 0,
      status_checked: false,
      notices: []
    };
  }
  const grouped = /* @__PURE__ */ new Map();
  for (const node of activeNodes) {
    const key = pyStr(nodeTaskRoot(state, node));
    if (!grouped.has(key)) grouped.set(key, /* @__PURE__ */ new Set());
    grouped.get(key).add(pyStr(node.task_id));
  }
  const deadline = deps3.monotonic() + waitMs / 1e3;
  const errors = /* @__PURE__ */ new Set();
  for (; ; ) {
    if (state.state_root && state.run_id && existsSync9(cancellationPath(state.state_root, state.run_id))) {
      return { status: "cancelling", event: "cancellation_requested", active: activeNodes.length, notices: [] };
    }
    const found = /* @__PURE__ */ Object.create(null);
    for (const [taskRootText, taskIds] of grouped) {
      const [notices, noticeErrors] = readCompletionNotices(taskRootText, taskIds);
      Object.assign(found, notices);
      for (const item of noticeErrors) errors.add(item);
    }
    if (Object.keys(found).length) {
      return {
        status: "ok",
        event: "completion_notice",
        active: activeNodes.length,
        status_checked: false,
        notice_count: Object.keys(found).length,
        notices: sortedStrings2(Object.keys(found)).map((taskId) => compactCompletionNotice(found[taskId])),
        errors: sortedStrings2(errors)
      };
    }
    const remaining = deadline - deps3.monotonic();
    if (remaining <= 0) {
      return {
        status: "waiting",
        event: "timeout",
        active: activeNodes.length,
        status_checked: false,
        notice_count: 0,
        notices: [],
        errors: sortedStrings2(errors)
      };
    }
    deps3.sleep(Math.min(Math.max(pollIntervalMs, 10) / 1e3, remaining));
  }
}
function asyncInternalBatchImpl(operation, taskRoot, taskIds, { detail = "compact" } = {}) {
  const statuses = /* @__PURE__ */ Object.create(null);
  const errors = [];
  const batchSize = operation === "get" && detail === "diagnostic" ? 5 : 20;
  for (let start = 0; start < taskIds.length; start += batchSize) {
    const batch = taskIds.slice(start, start + batchSize);
    const argv = [
      "node",
      ASYNC_SERVICE_PATH,
      "internal",
      operation,
      "--task-root",
      pyStr(taskRoot),
      "--task-ids",
      batch.join(",")
    ];
    if (operation === "get") argv.push("--detail", detail);
    const result = deps3.runCommand(argv, ROOT);
    if (result.exit_code !== 0) {
      errors.push((result.stderr || result.stdout).slice(0, 600));
      continue;
    }
    let data;
    try {
      data = parseJsonStdout(result, `async internal ${operation}`);
    } catch (error) {
      if (error?.name !== "ToolError") throw error;
      errors.push(String(error.message));
      continue;
    }
    const tasks = data.tasks;
    if (!Array.isArray(tasks)) {
      errors.push(`async internal ${operation} returned non-list tasks`);
      continue;
    }
    for (const task of tasks) {
      if (!isRecord(task) || !task.task_id) continue;
      const normalized = { ...task };
      const progress = isRecord(task.progress) ? task.progress : {};
      for (const key of [
        "elapsed_seconds",
        "live_age_seconds",
        "tool_call_count",
        "last_tool_kind",
        "live_health",
        "progress_state"
      ]) {
        if (Object.hasOwn(progress, key)) normalized[key] = progress[key];
      }
      if (Object.hasOwn(task, "write_domain_violation_count")) {
        normalized.write_domain_scope_compliant = task.write_domain_scope_compliant ?? false;
      }
      normalized.requires_parent_review = task.review_gate === "needs_parent_review";
      statuses[pyStr(task.task_id)] = normalized;
    }
  }
  return [statuses, errors];
}
function asyncInternalBatch(operation, taskRoot, taskIds, options = {}) {
  return deps3.asyncInternalBatch(operation, taskRoot, taskIds, options);
}
function refreshActiveNodes(state, { forceReconcile = false } = {}) {
  const watchedNodes = (Array.isArray(state.nodes) ? state.nodes : []).filter(
    (node) => isRecord(node) && node.task_id && (ACTIVE_STATES.has(node.state) || node.state === "paused" || node.resource_quarantined)
  );
  const summary = {
    active: watchedNodes.filter((node) => ACTIVE_STATES.has(node.state)).length,
    paused: watchedNodes.filter((node) => node.state === "paused").length,
    inbox: 0,
    queried: 0,
    reconciled: 0,
    inspection_deferred: 0,
    errors: []
  };
  const grouped = /* @__PURE__ */ new Map();
  for (const node of watchedNodes) {
    const key = pyStr(nodeTaskRoot(state, node));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }
  for (const [taskRootText, nodes] of grouped) {
    const taskRoot = taskRootText;
    const taskIds = new Set(nodes.filter((node) => node.task_id).map((node) => pyStr(node.task_id)));
    const [notices, noticeErrors] = readCompletionNotices(taskRoot, taskIds);
    summary.errors.push(...noticeErrors);
    for (const node of nodes) {
      const taskId = pyStr(node.task_id || "");
      const notice = notices[taskId];
      if (notice) {
        applyAsyncStatus(node, notice, "completion_notice", state);
        summary.inbox += 1;
      }
    }
    const remaining = nodes.filter(
      (node) => (ACTIVE_STATES.has(node.state) || node.state === "paused" || node.resource_quarantined) && !Object.hasOwn(notices, pyStr(node.task_id || ""))
    );
    const dueRemaining = remaining.filter((node) => node.state === "paused" || forceReconcile || livenessCheckDue(node));
    summary.inspection_deferred += remaining.length - dueRemaining.length;
    if (!dueRemaining.length) continue;
    const dueIds = dueRemaining.map((node) => pyStr(node.task_id || ""));
    const [queried, queryErrors] = deps3.asyncInternalBatch("get", taskRoot, dueIds, { detail: "diagnostic" });
    summary.errors.push(...queryErrors);
    const deadIds = [];
    for (const node of dueRemaining) {
      const taskId = pyStr(node.task_id || "");
      const status = queried[taskId];
      if (status && status.state === "paused") {
        applyAsyncStatus(node, status, "async_get", state);
        summary.queried += 1;
        continue;
      }
      if (status && ACTIVE_STATES.has(status.state) && status.process_alive === false) {
        deadIds.push(taskId);
      } else if (status) {
        applyAsyncStatus(node, status, "async_get", state);
        if (ACTIVE_STATES.has(node.state)) deferLivenessCheck(node);
        summary.queried += 1;
      } else {
        summary.errors.push(`async get missing task ${taskId}`);
      }
    }
    if (deadIds.length) {
      const [reconciled, reconcileErrors] = deps3.asyncInternalBatch("reconcile", taskRoot, deadIds);
      summary.errors.push(...reconcileErrors);
      for (const node of dueRemaining) {
        const taskId = pyStr(node.task_id || "");
        const status = reconciled[taskId];
        if (status) {
          applyAsyncStatus(node, status, "async_reconcile", state);
          summary.reconciled += 1;
        }
      }
    }
  }
  return summary;
}
function acceptanceLeafExpectedIds(manifestNode) {
  const seed = nodeSeed(manifestNode);
  const contract = isRecord(seed.contract) ? seed.contract : {};
  const context = isRecord(contract.acceptance_context) ? contract.acceptance_context : {};
  const items = Array.isArray(context.items) ? context.items : [];
  let ids2 = items.filter((item) => isRecord(item) && item.acceptance_id).map((item) => pyStr(item.acceptance_id));
  if (!ids2.length && context.acceptance_id) ids2 = [pyStr(context.acceptance_id)];
  return ids2;
}
function acceptanceResultsBlockIssue(reportPath, expectedIds) {
  let text3;
  try {
    text3 = pyReadText(reportPath);
  } catch {
    return `report not readable: ${rel(reportPath)}`;
  }
  const match = ACCEPTANCE_RESULTS_BLOCK.exec(text3);
  if (!match) return "missing ```json acceptance_results block";
  let payload;
  try {
    payload = pyJsonLoads(match[1]);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    return `acceptance_results block is invalid JSON: ${error.message}`;
  }
  const entries = isRecord(payload) ? payload.acceptance_results : null;
  if (!Array.isArray(entries)) return "acceptance_results block root must contain an acceptance_results list";
  const seen = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return "acceptance_results entries must be objects";
    if (!["pass", "fail", "needs_owner"].includes(entry.gate)) {
      return `acceptance_results gate invalid: ${pyStr(entry.gate ?? null)}`;
    }
    seen.push(pyStr(entry.acceptance_id ?? null));
  }
  const seenSorted = sortedStrings2(new Set(seen));
  const expectedSorted = sortedStrings2(new Set(expectedIds));
  if (!pyDictEqual(seenSorted, expectedSorted) || seen.length !== new Set(seen).size) {
    return `acceptance_results ids mismatch: got ${pyRepr(sortedStrings2(seen))}, expected ${pyRepr(sortedStrings2(expectedIds))}`;
  }
  return null;
}
function enforceAcceptanceResultsGate(state, manifestById, { reportRoot = null } = {}) {
  if (!Object.values(manifestById).some((node) => nodeIsReducer(node))) return [];
  const actions = [];
  const byId = indexNodes(state);
  for (const [nid, manifestNode] of Object.entries(manifestById)) {
    if (nodeIsReducer(manifestNode)) continue;
    const expectedIds = acceptanceLeafExpectedIds(manifestNode);
    if (!expectedIds.length) continue;
    const node = byId[nid];
    if (!node || node.state !== "done") continue;
    const taskId = pyStr(node.task_id || "");
    if (!taskId || node.acceptance_results_checked === taskId) continue;
    const slug = pyStr(nodeSeed(manifestNode).slug || "");
    const reportPath = path16.join(reportRoot || path16.join(ROOT, "notes", "verify"), `${slug}.md`);
    const issue = acceptanceResultsBlockIssue(reportPath, expectedIds);
    node.acceptance_results_checked = taskId;
    if (issue === null) {
      delete node.acceptance_results_block;
      continue;
    }
    node.acceptance_results_block = issue;
    actions.push({ node: nid, action: "derive_from_prose", issue });
  }
  return actions;
}
function downstreamCounts(manifestNodesList) {
  const ids2 = manifestNodesList.map((node) => nodeId(node));
  const reverse = /* @__PURE__ */ new Map();
  for (const nid of ids2) if (!reverse.has(nid)) reverse.set(nid, /* @__PURE__ */ new Set());
  for (const node of manifestNodesList) {
    const nid = nodeId(node);
    for (const dep of nodeDependsOn(node)) {
      if (reverse.has(dep)) reverse.get(dep).add(nid);
    }
  }
  const memo = /* @__PURE__ */ new Map();
  const visit = (nid) => {
    if (memo.has(nid)) return memo.get(nid);
    const children = /* @__PURE__ */ new Set();
    memo.set(nid, children);
    for (const child of reverse.get(nid) ?? /* @__PURE__ */ new Set()) {
      children.add(child);
      for (const item of visit(child)) children.add(item);
    }
    memo.set(nid, children);
    return children;
  };
  const out = /* @__PURE__ */ Object.create(null);
  for (const nid of ids2) out[nid] = visit(nid).size;
  return out;
}
function dependenciesReady(node, byId) {
  const policy = pyStr(node.dependency_policy || "all_succeeded");
  for (const dep of node.depends_on || []) {
    const depNode = byId[dep] ?? {};
    const depState = depNode.state;
    if (depNode.kind === "gate") {
      if (depState !== "done") return false;
      continue;
    }
    if (depState === "needs_parent_review" && requiresSafetyReview(depNode.last_status || {})) return false;
    if (policy === "all_settled") {
      if (!TERMINAL_STATES.has(depState)) return false;
    } else if (depState !== "done") {
      return false;
    }
  }
  return true;
}
function blockedByFailedDependency(node, byId) {
  const toleratesFailure = pyStr(node.dependency_policy || "all_succeeded") === "all_settled" || pyStr(node.failure_policy || "success_only") === "all_settled";
  for (const dep of node.depends_on || []) {
    const depNode = byId[dep] ?? {};
    const depState = depNode.state;
    if (!FAILED_DEPENDENCY_STATES.has(depState)) continue;
    if (depNode.kind === "gate" || !toleratesFailure) return pyStr(dep);
  }
  return null;
}
function registerAllSettledConsumers(state) {
  const byId = indexNodes(state);
  const consumersByDependency = /* @__PURE__ */ new Map();
  for (const consumer of Array.isArray(state.nodes) ? state.nodes : []) {
    if (!isRecord(consumer) || consumer.dependency_policy !== "all_settled") continue;
    const consumerId = pyStr(consumer.id || "");
    for (const dependencyId of consumer.depends_on || []) {
      const key = pyStr(dependencyId);
      if (!consumersByDependency.has(key)) consumersByDependency.set(key, []);
      consumersByDependency.get(key).push(consumerId);
    }
  }
  const changed = [];
  for (const [dependencyId, consumerIds] of consumersByDependency) {
    const dependency = byId[dependencyId];
    if (!dependency || !TERMINAL_STATES.has(dependency.state)) continue;
    if (dependency.kind === "gate" || requiresSafetyReview(dependency.last_status || {})) {
      continue;
    }
    const normalizedConsumers = sortedStrings2(new Set(consumerIds));
    if (!pyDictEqual(dependency.all_settled_consumers ?? null, normalizedConsumers)) {
      dependency.all_settled_consumers = normalizedConsumers;
      changed.push(dependencyId);
    }
    if (dependency.state === "needs_parent_review") {
      const lastStatus = isRecord(dependency.last_status) ? dependency.last_status : {};
      const executionState = lastStatus.state;
      if (!ASYNC_TERMINAL_STATES.has(executionState)) continue;
      setNodeState(state, dependency, executionState, {
        eventType: "agent_settled",
        businessState: pyStr(lastStatus.business_state || "") || null,
        review_deferred_to: normalizedConsumers
      });
      dependency.review_required = false;
      dependency.review_decision = null;
      dependency.review_deferred_to = normalizedConsumers;
      changed.push(dependencyId);
    }
    dependency.updated_at = utcNow();
  }
  return sortedStrings2(new Set(changed));
}
function releaseResolvedDependencyBlocks(state, byId) {
  const released = [];
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (!isRecord(node) || node.state !== "blocked") continue;
    const blocker = pyStr(node.blocked_by || "");
    const dependencies = new Set((node.depends_on || []).map((dep) => pyStr(dep)));
    if (!dependencies.has(blocker)) continue;
    const blockerState = (byId[blocker] ?? {}).state;
    if (pyStr(node.dependency_policy || "all_succeeded") !== "all_settled" && FAILED_DEPENDENCY_STATES.has(blockerState)) {
      continue;
    }
    node.state = "pending";
    delete node.blocked_by;
    node.updated_at = utcNow();
    released.push(pyStr(node.id || ""));
  }
  return released;
}
function reviewEvidencePath(value) {
  if (!pyStrip(value)) throw new ToolError("review evidence is required");
  const resolved = requireRepoInternal(resolveUnder(pyStrip(value), ROOT), "review evidence");
  if (!existsSync9(resolved)) throw new ToolError(`review evidence does not exist: ${rel(resolved)}`);
  return rel(resolved);
}
function appendReviewRecord(node, record2) {
  if (!Object.hasOwn(node, "review_history")) node.review_history = [];
  const history = node.review_history;
  if (Array.isArray(history)) {
    history.push(record2);
    if (history.length > 20) history.splice(0, history.length - 20);
  }
  node.review = record2;
  node.review_decision = record2.decision;
  node.review_required = false;
  node.reviewed_at = record2.reviewed_at;
  return null;
}
function reviewRun(runId, root, nodeIdValue, decision, evidence, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  return runMutationLock(resolvedRoot, runId, () => reviewRunLocked(runId, resolvedRoot, nodeIdValue, decision, evidence, reason));
}
function reviewRunLocked(runId, root, nodeIdValue, decision, evidence, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = loadJson(target);
  const node = indexNodes(state)[nodeIdValue];
  if (!node) throw new ToolError(`node not found: ${nodeIdValue}`);
  if (existsSync9(cancellationPath(resolvedRoot, runId))) throw new ToolError("fleet cancellation requested; start a new run instead of reviewing this run");
  const currentState = node.state;
  const settledRequeue = decision === "requeued" && ["done", "blocked", "failed", "cancelled"].includes(currentState);
  if (node.resource_quarantined || currentState !== "needs_parent_review" && !settledRequeue) {
    throw new ToolError(`node is not waiting for parent review: ${nodeIdValue} state=${pyStr(node.state ?? null)}`);
  }
  const evidencePath = decision === "requeued" && !pyStrip(evidence) ? null : reviewEvidencePath(evidence);
  const record2 = {
    decision,
    evidence_path: evidencePath,
    reason: pyStrip(reason),
    reviewed_at: utcNow(),
    previous_state: node.state ?? null,
    previous_task_id: node.task_id ?? null
  };
  let reviewRound = positiveInt(node.review_round);
  if (decision !== "accepted") reviewRound += 1;
  node.review_round = reviewRound;
  record2.round = reviewRound;
  appendReviewRecord(node, record2);
  const fuseTripped = false;
  if (decision === "accepted") {
    setNodeState(state, node, "done", { eventType: "agent_settled", businessState: "completed" });
    delete node.blocked_by;
  } else if (decision === "blocked") {
    setNodeState(state, node, "blocked", { eventType: "agent_settled", businessState: "blocked" });
    node.blocked_by = "parent_review";
  } else if (decision === "requeued") {
    const previousTaskId = pyStr(node.task_id || "");
    if (previousTaskId) {
      if (!Object.hasOwn(node, "superseded_task_ids")) node.superseded_task_ids = [];
      const superseded = node.superseded_task_ids;
      if (Array.isArray(superseded) && !superseded.includes(previousTaskId)) {
        superseded.push(previousTaskId);
        if (superseded.length > 20) superseded.splice(0, superseded.length - 20);
      }
    }
    node.task_id = null;
    node.receipt_task_id = null;
    node.dispatch = null;
    node.last_status = null;
    node.review_required = false;
    node.review_decision = null;
    node.review = null;
    delete node.reviewed_at;
    delete node.next_liveness_check_at;
    delete node.blocked_by;
    setNodeState(state, node, "pending", { eventType: "agent_progress", businessState: "queued" });
  } else {
    throw new ToolError("review decision must be accepted, blocked or requeued");
  }
  node.updated_at = utcNow();
  state.updated_at = utcNow();
  appendFleetEvent(state, "review", node, {
    incrementNodeRevision: false,
    decision,
    evidence_path: evidencePath,
    review_round: reviewRound,
    fuse_tripped: fuseTripped
  });
  const manifest = loadManifestSnapshotForStatus(state);
  if (manifest) rebuildReadyQueue(state, Array.isArray(manifest.nodes) ? [...manifest.nodes] : []);
  writeJson2(target, state);
  return {
    status: "ok",
    run_id: runId,
    node_id: nodeIdValue,
    decision,
    node_state: node.state,
    review_round: reviewRound,
    fuse_tripped: fuseTripped,
    state_path: rel(target)
  };
}
function activeWriteScopes(state) {
  const scopes = [];
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (isRecord(node) && (ACTIVE_STATES.has(node.state) || node.resource_quarantined)) {
      scopes.push([pyStr(node.id ?? null), [...node.write_scope || []]]);
    }
  }
  return scopes;
}
function activeResourceLocks(state) {
  const locks = [];
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (isRecord(node) && (ACTIVE_STATES.has(node.state) || node.resource_quarantined)) {
      const raw = node.resource_locks;
      const values = Array.isArray(raw) ? sortedStrings2(new Set(raw.map((item) => pyStrip(pyStr(item))).filter((item) => item))) : [];
      if (values.length) locks.push([pyStr(node.id || ""), values]);
    }
  }
  return locks;
}
function writeLocked(node, active) {
  const scope = [...node.write_scope || []];
  if (!scope.length) return null;
  for (const [owner, otherScope] of active) {
    for (const left of scope) {
      for (const right of otherScope) {
        if (pathConflict(left, right)) return owner;
      }
    }
  }
  return null;
}
function resourceLocked(node, active) {
  const requested = new Set(
    (node.resource_locks || []).map((item) => pyStrip(pyStr(item))).filter((item) => item)
  );
  if (!requested.size) return null;
  for (const [owner, held] of active) {
    if (held.some((item) => requested.has(item))) return owner;
  }
  return null;
}
function budgetAllows(node, state, submittedThisTick) {
  const budget = isRecord(state.budget) ? state.budget : {};
  const activeNodes = (Array.isArray(state.nodes) ? state.nodes : []).filter(
    (n) => isRecord(n) && ACTIVE_STATES.has(n.state)
  );
  const maxTotal = pyInt(budget.max_running_total || 8);
  const maxTick = pyInt(budget.max_submitted_per_tick || maxTotal);
  if (activeNodes.length >= maxTotal) return [false, `max_running_total ${maxTotal} reached`];
  if (submittedThisTick >= maxTick) return [false, `max_submitted_per_tick ${maxTick} reached`];
  const roleLimits = isRecord(budget.max_running_by_role) ? budget.max_running_by_role : {};
  const role = pyStr(node.role || "");
  const roleLimit = roleLimits[role];
  if (typeof roleLimit === "number" && Number.isInteger(roleLimit) && typeof roleLimit !== "boolean" && roleLimit > 0) {
    const roleActive = activeNodes.filter((n) => n.role === role).length;
    if (roleActive >= roleLimit) return [false, `max_running_by_role.${role} ${roleLimit} reached`];
  }
  return [true, ""];
}
function ensureWorktree(state, node) {
  const worktreeRoot = path16.join(runDir(pyStr(state.state_root), state.run_id), "worktrees");
  const worktree = path16.join(worktreeRoot, safeId(pyStr(node.id)));
  if (node.worktree_path) return pyStr(node.worktree_path);
  if (existsSync9(worktree)) throw new ToolError(`worktree path already exists before dispatch: ${rel(worktree)}`);
  const result = deps3.runCommand(["git", "worktree", "add", "--detach", worktree, "HEAD"], ROOT, { timeout: 120 });
  if (result.exit_code !== 0) {
    throw new ToolError(`git worktree add failed for ${node.id}: ${result.stderr.slice(0, 600)}`);
  }
  node.worktree_path = worktree;
  return worktree;
}
function dependencyResultEntries(state, node, manifestNode) {
  const requested = nodeDependencyArtifacts(manifestNode);
  const policy = nodeDependencyPolicy(manifestNode);
  const byId = indexNodes(state);
  const resolved = [];
  const entries = [];
  for (const dependencyId of node.depends_on || []) {
    const dependency = byId[pyStr(dependencyId)] ?? {};
    const lastStatus = isRecord(dependency.last_status) ? dependency.last_status : {};
    const dispatch = isRecord(dependency.dispatch) ? dependency.dispatch : {};
    const businessOutput = isRecord(dispatch.business_output) ? dispatch.business_output : {};
    const artifactPaths = {};
    const missingArtifacts = [];
    const requestedForDep = dependency.kind === "gate" ? [] : requested;
    for (const artifact of requestedForDep) {
      const candidates = artifact === "report" ? [
        lastStatus.business_report_path,
        lastStatus.report_path,
        lastStatus.declared_report_path,
        businessOutput.expected_report_path
      ] : [
        lastStatus.business_handoff_path,
        lastStatus.handoff_path,
        lastStatus.declared_handoff_path,
        businessOutput.expected_handoff_path
      ];
      let selected = "";
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || !pyStrip(candidate)) continue;
        const target = resolveUnder(candidate, ROOT);
        if (existsSync9(target)) {
          selected = target;
          break;
        }
      }
      if (!selected) {
        missingArtifacts.push(artifact);
        if (policy !== "all_settled") {
          throw new ToolError(
            `node ${pyStr(node.id ?? null)} dependency ${dependencyId} has no durable ${artifact} artifact`
          );
        }
        continue;
      }
      artifactPaths[artifact] = selected;
      if (!resolved.includes(selected)) resolved.push(selected);
    }
    let artifactState;
    if (!requestedForDep.length) artifactState = "not_requested";
    else if (!missingArtifacts.length) artifactState = "available";
    else if (Object.keys(artifactPaths).length) artifactState = "partial";
    else artifactState = "missing";
    const entry = {
      node_id: pyStr(dependencyId),
      execution_state: lastStatus.state || dependency.state || "unknown",
      orchestration_state: dependency.state || "unknown",
      business_state: lastStatus.business_state || "unknown",
      artifact_state: artifactState,
      artifacts: artifactPaths,
      missing_artifacts: missingArtifacts
    };
    for (const key of ["contract_state", "failure_type", "error"]) {
      const value = lastStatus[key];
      if (notEmptyPy(value)) entry[key] = typeof value === "string" ? shortText(value) : value;
    }
    const blockIssue = dependency.acceptance_results_block;
    if (blockIssue) {
      entry.acceptance_results_block = typeof blockIssue === "string" ? shortText(blockIssue) : blockIssue;
    }
    entries.push(entry);
  }
  return [resolved, entries];
}
function writeDependencyResultIndex(state, node, manifestNode, entries) {
  const root = pyStr(state.state_root);
  const target = dependencyResultIndexPath(root, pyStr(state.run_id), pyStr(node.id));
  writeJson2(target, {
    schema_version: 1,
    consumer_node_id: pyStr(node.id),
    dependency_policy: "all_settled",
    requested_artifacts: nodeDependencyArtifacts(manifestNode),
    dependencies: entries
  });
  return resolveLikePython(target);
}
function seedWithDependencyArtifacts(state, node, manifestNode, manifest = {}) {
  const seed = nodeSeed(manifestNode);
  const writes = [...stringList2(manifestNode.write_scope), ...stringList2(manifestNode.write_domains)];
  if (writes.length && nodeIsolation(manifestNode, manifest) !== "read_only" && nodeTargetIsolation(manifestNode, manifest) !== "read_only") {
    seed.scope ??= {};
    seed.scope.write_extra = dedupe([...seed.scope.write_extra || [], ...writes]);
  }
  let [artifacts, entries] = dependencyResultEntries(state, node, manifestNode);
  if (nodeDependencyPolicy(manifestNode) === "all_settled") {
    const indexPath = writeDependencyResultIndex(state, node, manifestNode, entries);
    artifacts = [indexPath, ...artifacts];
  }
  if (!artifacts.length) return seed;
  if (!Object.hasOwn(seed, "scope")) seed.scope = {};
  const scope = seed.scope;
  if (!isRecord(scope)) throw new ToolError(`node ${pyStr(node.id ?? null)} seed.scope must be an object`);
  const reads = Object.hasOwn(scope, "read") ? scope.read : [];
  if (!Array.isArray(reads)) throw new ToolError(`node ${pyStr(node.id ?? null)} seed.scope.read must be a list`);
  scope.read = dedupe([...artifacts, ...reads]);
  const layers = seed.read_scope_layers;
  if (isRecord(layers)) {
    const entry = Object.hasOwn(layers, "entry") ? layers.entry : [];
    if (!Array.isArray(entry)) {
      throw new ToolError(`node ${pyStr(node.id ?? null)} seed.read_scope_layers.entry must be a list`);
    }
    layers.entry = dedupe([...artifacts, ...entry]);
  }
  return seed;
}
function markFailure(node, { contractState, failureType, error, fleetState = null } = {}) {
  node.state = "failed";
  node.review_required = false;
  node.review_decision = null;
  node.last_status = {
    source: "fleet_scheduler",
    state: "failed",
    business_state: "failed",
    contract_state: contractState,
    failure_type: failureType,
    error
  };
  node.updated_at = utcNow();
  if (fleetState) appendFleetEvent(fleetState, "agent_settled", node, {
    businessState: "failed",
    contract_state: contractState,
    failure_type: failureType,
    error,
    attention_required: true,
    route: routeSnapshot(node)
  });
}
function markParentReview(node, { contractState, failureType, error, fleetState = null } = {}) {
  node.state = "needs_parent_review";
  node.review_required = true;
  node.review_decision = "pending";
  node.last_status = {
    source: "fleet_scheduler",
    state: "failed",
    business_state: "failed",
    contract_state: contractState,
    failure_type: failureType,
    requires_parent_review: true,
    safety_review: true,
    error
  };
  node.updated_at = utcNow();
  if (fleetState !== null && fleetState !== void 0) {
    appendFleetEvent(fleetState, "agent_settled", node, {
      businessState: "needs_owner",
      contract_state: contractState,
      failure_type: failureType,
      error,
      route: routeSnapshot(node)
    });
  }
  return null;
}
function promoteLegacyDispatchFailureBlocks(state) {
  const promoted = [];
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (!isRecord(node) || node.state !== "blocked") continue;
    if (node.task_id || node.blocked_by || node.last_status) continue;
    const dispatch = node.dispatch;
    if (!isRecord(dispatch)) continue;
    let error = pyStrip(pyStr(dispatch.error || dispatch.stdout || ""));
    if (!error) error = "legacy dispatch failure recorded without output";
    markFailure(node, {
      contractState: "dispatch_prepare_failed",
      failureType: "legacy_dispatch_failure",
      error,
      fleetState: state
    });
    promoted.push(pyStr(node.id || ""));
  }
  return promoted;
}
function commandNodeCwd(spec) {
  const declared = pyStrip(pyStr(spec.cwd || ""));
  if (!declared) return ROOT;
  const cwd = resolveLikePython(pathlibJoin(ROOT, declared));
  if (!pyIsRelativeTo(cwd, ROOT)) {
    throw new ToolError(`command cwd escapes repository root: ${declared}`);
  }
  return cwd;
}
function commandNodeEnv(state, node, manifestNode) {
  const env = { ...process8.env };
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  env.FLEET_RUN_ID = runId;
  env.FLEET_NODE_ID = pyStr(node.id || "");
  env.FLEET_RUN_DIR = runDir(root, runId);
  env.FLEET_STATE_PATH = statePath(root, runId);
  if (!nodeDependencyArtifacts(manifestNode).length) return env;
  const [artifacts, entries] = dependencyResultEntries(state, node, manifestNode);
  if (nodeDependencyPolicy(manifestNode) === "all_settled") {
    env.FLEET_DEPENDENCY_RESULT_INDEX = writeDependencyResultIndex(state, node, manifestNode, entries);
  }
  if (artifacts.length) env.FLEET_DEPENDENCY_ARTIFACTS = artifacts.join(path16.delimiter);
  return env;
}
function executeCommandNode(state, node, manifestNode, { dryRun = false } = {}) {
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  const spec = nodeCommand(manifestNode);
  const argv = [...spec.argv || []];
  let cwd;
  try {
    if (!argv.length) throw new ToolError(`command node ${pyStr(node.id ?? null)} has no argv`);
    cwd = commandNodeCwd(spec);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    markFailure(node, {
      contractState: "command_invalid",
      failureType: "command_invalid",
      error: String(error.message),
      fleetState: state
    });
    return {
      status: "failed",
      node_id: node.id,
      error: String(error.message)
    };
  }
  const timeout = pyInt(spec.timeout_seconds || 600);
  if (dryRun) {
    return {
      status: "ok",
      node_id: node.id,
      dry_run: true,
      dispatch: { would_run: argv, cwd, timeout_seconds: timeout }
    };
  }
  let env;
  try {
    env = commandNodeEnv(state, node, manifestNode);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    markFailure(node, {
      contractState: "dependency_artifact_missing",
      failureType: "dependency_artifact_missing",
      error: String(error.message),
      fleetState: state
    });
    return { status: "failed", node_id: node.id, error: String(error.message) };
  }
  const attempt = positiveInt(node.command_attempts) + 1;
  node.command_attempts = attempt;
  const logsDir = path16.join(runDir(root, runId), "commands");
  mkdirSync8(logsDir, { recursive: true });
  const stdoutPath = path16.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.stdout.log`);
  const stderrPath = path16.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.stderr.log`);
  const startedAt = deps3.monotonic();
  let failure = null;
  let exitCode = null;
  let stdoutText = "";
  let stderrText = "";
  const workerResultPath = path16.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.process.json`);
  const workerSpecPath = path16.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.spec.json`);
  writeJson2(workerSpecPath, { argv, cwd, timeout_ms: timeout * 1e3, cancel_path: cancellationPath(root, runId), result_path: workerResultPath });
  const proc = pySpawnSync(process8.execPath, [SCHEDULER_CLI_PATH, "command-worker", "--spec", workerSpecPath], {
    cwd,
    env,
    encoding: "utf8",
    timeout: (timeout + 40) * 1e3,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024
  });
  const workerResult = existsSync9(workerResultPath) ? loadJson(workerResultPath) : null;
  if (workerResult?.cancelled || existsSync9(cancellationPath(root, runId)) && !workerResult) {
    writeFileSync6(stdoutPath, pyStr(proc.stdout ?? ""));
    writeFileSync6(stderrPath, pyStr(proc.stderr ?? ""));
    node.command_termination = workerResult || { confirmed: false, error: "command supervisor result missing" };
    setNodeState(state, node, workerResult?.confirmed ? "cancelled" : "running", { eventType: workerResult?.confirmed ? "agent_settled" : "agent_progress", businessState: workerResult?.confirmed ? "cancelled" : "running" });
    node.command_result = { argv, cwd, attempt, stdout_path: stdoutPath, stderr_path: stderrPath };
    node.not_executed = Boolean(workerResult?.not_executed);
    node.cancel_reason = "user_requested";
    return { status: "ok", node_id: node.id, terminal: Boolean(workerResult?.confirmed), cancelled: Boolean(workerResult?.confirmed) };
  }
  stdoutText = pyStr(proc.stdout ?? "");
  stderrText = pyStr(proc.stderr ?? "");
  if (workerResult?.timed_out) {
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else if (workerResult?.error) {
    failure = [workerResult.error_code === "ENOENT" ? "command_not_found" : "command_spawn_failed", workerResult.error];
  } else if (proc.error && proc.error.code === "ENOENT") {
    failure = ["command_not_found", `command executable not found: ${argv[0]}`];
  } else if (proc.error && proc.error.code === "ETIMEDOUT") {
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else if (proc.error) {
    failure = ["command_spawn_failed", `command spawn failed: ${proc.error.message}`];
  } else if (proc.signal && proc.status === null) {
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else {
    exitCode = proc.status;
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    if (exitCode !== 0) {
      failure = ["command_failed", `command exited ${exitCode}: ${pyStrip(stderrText).slice(0, 800)}`];
    }
  }
  const durationSeconds = Math.round((deps3.monotonic() - startedAt) * 1e3) / 1e3;
  try {
    writeFileSync6(stdoutPath, stdoutText, "utf8");
    writeFileSync6(stderrPath, stderrText, "utf8");
  } catch (error) {
    if (failure === null) failure = ["command_log_write_failed", `cannot persist command logs: ${error.message}`];
  }
  node.command_result = {
    argv,
    cwd,
    attempt,
    exit_code: exitCode,
    duration_seconds: durationSeconds,
    stdout_path: stdoutPath,
    stderr_path: stderrPath
  };
  node.updated_at = utcNow();
  if (failure !== null) {
    const [contractState, error] = failure;
    const quarantined = !workerResult?.confirmed;
    node.resource_quarantined = quarantined;
    (quarantined ? markParentReview : markFailure)(node, {
      contractState,
      failureType: quarantined ? "retained_worker" : contractState,
      error,
      fleetState: state
    });
    node.last_status.stdout_path = stdoutPath;
    node.last_status.stderr_path = stderrPath;
    return {
      status: node.state,
      node_id: node.id,
      error
    };
  }
  node.last_status = {
    source: "fleet_command",
    state: "done",
    business_state: "completed",
    exit_code: 0,
    duration_seconds: durationSeconds,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    // 命令的 stdout 就是它对下游的正式产物，接进 dependency_artifacts 的 report 解析链。
    report_path: stdoutPath
  };
  setNodeState(state, node, "done", {
    eventType: "agent_settled",
    businessState: "completed",
    command: argv[0],
    duration_seconds: durationSeconds
  });
  return {
    status: "ok",
    node_id: node.id,
    terminal: true,
    exit_code: 0,
    stdout_path: stdoutPath,
    stderr_path: stderrPath
  };
}
function openGateNode(state, node, { dryRun = false } = {}) {
  if (dryRun) {
    return {
      status: "ok",
      node_id: node.id,
      dry_run: true,
      dispatch: { gate: "would_open" }
    };
  }
  node.review_required = true;
  node.review_decision = "pending";
  node.last_status = {
    source: "fleet_gate",
    state: "needs_parent_review",
    business_state: "gate_open",
    requires_parent_review: true
  };
  setNodeState(state, node, "needs_parent_review", {
    eventType: "gate_opened",
    businessState: "gate_open"
  });
  return { status: "ok", node_id: node.id, terminal: true, gate: "opened" };
}
function dispatchNodeImpl(state, manifest, node, manifestNode, { dryRun = false } = {}) {
  const kind = pyStr(node.kind || nodeKind(manifestNode));
  if (kind === "command") return executeCommandNode(state, node, manifestNode, { dryRun });
  if (kind === "gate") return openGateNode(state, node, { dryRun });
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  let seed;
  try {
    seed = seedWithDependencyArtifacts(state, node, manifestNode, manifest);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    if (!nodeDependencyArtifacts(manifestNode).length) throw error;
    markFailure(node, {
      contractState: "dependency_artifact_missing",
      failureType: "dependency_artifact_missing",
      error: String(error.message),
      fleetState: state
    });
    return { status: "failed", node_id: node.id, error: String(error.message) };
  }
  const seedFile = seedPath(root, runId, pyStr(node.id));
  writeJson2(seedFile, seed);
  let dispatchCwd = ROOT;
  if (node.isolation === "worktree") {
    dispatchCwd = dryRun ? path16.join(runDir(root, runId), "worktrees", safeId(pyStr(node.id))) : ensureWorktree(state, node);
  }
  const cmd = [
    process8.execPath,
    DISPATCH_PREPARE_PATH,
    "--seed-stdin",
    "--format",
    "json",
    "--async-task-root",
    pyStr(nodeTaskRoot(state, node)),
    "--batch-id",
    runId
  ];
  const dispatchOverrides = isRecord(state.dispatch_overrides) ? state.dispatch_overrides : {};
  const requestedRoute = frozenRequestedRoute(node);
  if (requestedRoute) {
    if (Object.hasOwn(requestedRoute, "pick")) cmd.push("--async-pick", requestedRoute.pick);
    if (Object.hasOwn(requestedRoute, "model")) cmd.push("--async-model", requestedRoute.model);
    if (Object.hasOwn(requestedRoute, "effort")) cmd.push("--async-effort", requestedRoute.effort);
    if (Object.hasOwn(requestedRoute, "authorization")) {
      cmd.push("--async-authorization", typeof requestedRoute.authorization === "string" ? requestedRoute.authorization : pyJsonDumps(requestedRoute.authorization));
    }
  }
  if (dispatchOverrides.context_mode) {
    cmd.push("--async-context-mode", pyStr(dispatchOverrides.context_mode));
  }
  if (dryRun) cmd.push("--action", "preview");
  let result;
  if (dryRun) {
    result = {
      status: "ok",
      dry_run: true,
      would_run: cmd,
      cwd: dispatchCwd,
      seed_path: rel(seedFile)
    };
  } else {
    const raw = deps3.runCommand(cmd, dispatchCwd, {
      stdin: pyJsonDumps(seed),
      timeout: DISPATCH_PREPARE_TIMEOUT_SECONDS
    });
    if (raw.exit_code !== 0) {
      const stderr = raw.stderr.slice(0, 1200);
      const stdout = raw.stdout.slice(0, 1200);
      const error = pyStrip(stderr) || pyStrip(stdout) || `dispatch_prepare exited ${raw.exit_code} without output`;
      node.dispatch = { exit_code: raw.exit_code, error: stderr, stdout };
      const safetyFailure = /write claim|identity|write.domain|write.scope|retained.worker/i.test(error);
      (safetyFailure ? markParentReview : markFailure)(node, {
        contractState: "dispatch_prepare_failed",
        failureType: error.toLowerCase().includes("write claim") ? "write_claim_conflict" : "dispatch_prepare_exit",
        error,
        fleetState: state
      });
      return {
        status: node.state,
        node_id: node.id,
        error
      };
    }
    result = parseJsonStdout(raw, "dispatch_prepare");
  }
  node.dispatch = result;
  const frozenSelection = isRecord(result.selection) ? result.selection : isRecord(result.async_preview?.selection) ? result.async_preview.selection : isRecord(result.async_model_selection?.selection) ? result.async_model_selection.selection : null;
  if (frozenSelection) ensureRouteRecord(node).frozen = deepCopy2(frozenSelection);
  node.updated_at = utcNow();
  if (dryRun) return { status: "ok", node_id: node.id, dry_run: true, dispatch: result };
  const taskId = result.task_id;
  if (!taskId) {
    const error = "dispatch result missing task_id";
    markParentReview(node, {
      contractState: "dispatch_result_invalid",
      failureType: "dispatch_missing_task_id",
      error,
      fleetState: state
    });
    return {
      status: "needs_parent_review",
      node_id: node.id,
      reason: "dispatch_result_requires_parent_review",
      error
    };
  }
  node.task_id = taskId;
  node.receipt_task_id = taskId;
  if (result.warnings?.length) node.warnings = [...result.warnings];
  else delete node.warnings;
  updateRouteFromPayload(node, result, "dispatch_receipt");
  node.task_root = pyStr(nodeTaskRoot(state, node));
  setNodeState(state, node, pyStr(result.state || "submitted"), {
    eventType: "agent_started",
    businessState: pyStr(result.business_state || "") || null,
    dispatch_source: "dispatch_prepare",
    route: routeSnapshot(node)
  });
  node.next_liveness_check_at = utcAfter(INITIAL_LIVENESS_GRACE_SECONDS);
  return { status: "ok", node_id: node.id, task_id: taskId, dispatch: result };
}
function dispatchNode(state, manifest, node, manifestNode, options = {}) {
  return deps3.dispatchNode(state, manifest, node, manifestNode, options);
}
function compactDispatchOutcome(outcome) {
  const data = {};
  for (const key of ["status", "node_id", "task_id", "dry_run", "error"]) {
    if (notEmptyPy(outcome[key])) data[key] = outcome[key];
  }
  const dispatch = outcome.dispatch;
  if (isRecord(dispatch)) {
    for (const key of [
      "delivery_mode",
      "resolved_delivery",
      "warnings",
      "model",
      "effort",
      "package_id",
      "task_package_path",
      "seed_path",
      "cwd"
    ]) {
      if (notEmptyPy(dispatch[key])) data[key] = dispatch[key];
    }
    const businessOutput = dispatch.business_output;
    if (isRecord(businessOutput)) {
      for (const key of ["expected_report_path", "expected_handoff_path"]) {
        if (notEmptyPy(businessOutput[key])) data[key] = businessOutput[key];
      }
    }
  }
  return data;
}
function settleFleetIfNeeded(state) {
  const terminal = (Array.isArray(state.nodes) ? state.nodes : []).every(
    (node) => isRecord(node) && TERMINAL_STATES.has(node.state)
  );
  if (!terminal) return false;
  const outcomeState = driverOutcome(state);
  state.run_state = outcomeState;
  let previousOutcome = null;
  const events = state.events;
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (isRecord(event) && event.type === "fleet_settled") {
        previousOutcome = event.business_state ?? null;
        break;
      }
    }
  }
  if (previousOutcome === outcomeState) {
    state.fleet_settled_emitted = true;
    return false;
  }
  appendFleetEvent(state, "fleet_settled", null, {
    businessState: outcomeState,
    incrementNodeRevision: false,
    counts: stateCounts(state)
  });
  state.fleet_settled_emitted = true;
  return true;
}
function cancellationPath(root, runId) {
  return path16.join(runDir(root, runId), "cancel-request.json");
}
function cancelRun(runId, root, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  if (!String(reason || "").trim()) throw new ToolError("cancellation reason is required");
  loadJson(statePath(resolvedRoot, runId));
  try {
    writeFileSync6(cancellationPath(resolvedRoot, runId), JSON.stringify({ reason, requested_at: utcNow() }), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  try {
    return runMutationLock(resolvedRoot, runId, () => {
      const state = loadJson(statePath(resolvedRoot, runId));
      return settleCancellation(state);
    }, { timeoutSeconds: 5 });
  } catch (error) {
    if (!String(error.message).startsWith("fleet run mutation lock busy:")) throw error;
    return { status: "cancelling", run_id: runId, reason: "waiting_for_inflight_operation", submitted: [] };
  }
}
function missingTaskStoppedByReboot(state, node, taskRoot, failures) {
  if (failures.length !== 1) return false;
  let lookup;
  try {
    lookup = JSON.parse(failures[0]);
  } catch {
    return false;
  }
  if (lookup?.error !== `Unknown task_id: ${node.task_id}`) return false;
  if (existsSync9(path16.join(taskRoot, node.task_id))) return false;
  const started = (state.events || []).filter((event) => event.type === "agent_started" && event.node_id === node.id && event.task_id === node.task_id);
  if (started.length !== 1) return false;
  const dispatchedAt = Date.parse(started[0].at || started[0].timestamp || "");
  const bootTime = Number(deps3.bootTimeMs());
  return Number.isFinite(dispatchedAt) && Number.isFinite(bootTime) && dispatchedAt + HOST_REBOOT_MARGIN_MS < bootTime && !(state.events || []).some((event) => event.node_id === node.id && event.task_id === node.task_id && event.type !== "agent_started" && Date.parse(event.at || event.timestamp || "") >= bootTime);
}
function settleCancellation(state) {
  const errors = [];
  for (const node of state.nodes || []) {
    if ((ACTIVE_STATES.has(node.state) || node.state === "paused" || node.resource_quarantined) && node.task_id) {
      const taskRoot = nodeTaskRoot(state, node);
      try {
        node.cancel_reason = "user_requested";
        const [statuses, failures] = asyncInternalBatch("get", taskRoot, [node.task_id]);
        let status = statuses[node.task_id];
        if (!status && missingTaskStoppedByReboot(state, node, taskRoot, failures)) {
          setNodeState(state, node, "cancelled", {
            eventType: "agent_settled",
            businessState: "unknown",
            source: "host_reboot_missing_task"
          });
          node.missing_task_evidence = { task_id: node.task_id, source: "host_reboot", outcome: "unknown" };
          node.resource_quarantined = false;
          continue;
        }
        errors.push(...failures);
        if (!status) continue;
        if (!ASYNC_TERMINAL_STATES.has(status.state) || node.resource_quarantined) {
          const result = deps3.runCommand([
            process8.execPath,
            ASYNC_SERVICE_PATH,
            "internal",
            "cancel",
            "--task-root",
            taskRoot,
            "--task-id",
            node.task_id,
            "--expected-revision",
            String(status.revision),
            "--reason",
            "user_requested"
          ], ROOT);
          if (result.exit_code !== 0) errors.push((result.stderr || result.stdout).slice(0, 600));
          const [latest, refreshErrors] = asyncInternalBatch("get", taskRoot, [node.task_id]);
          errors.push(...refreshErrors);
          status = latest[node.task_id];
        }
        if (status) applyAsyncStatus(node, status, "fleet_cancel", state);
      } catch (error) {
        errors.push(`${node.id}: ${error.message}`);
      }
    } else if (ACTIVE_STATES.has(node.state) || node.resource_quarantined) {
      errors.push(`${node.id}: active execution has no confirmed termination`);
    } else if (node.state === "paused") {
      errors.push(`${node.id}: paused execution has no task_id; not marked cancelled`);
    } else if (!TERMINAL_STATES.has(node.state)) {
      setNodeState(state, node, "cancelled", { eventType: "agent_settled", businessState: "cancelled" });
      node.cancel_reason = "user_requested";
      node.not_executed = true;
    }
  }
  state.ready_queue = [];
  const active = (state.nodes || []).filter((node) => ACTIVE_STATES.has(node.state) || node.resource_quarantined);
  state.run_state = active.length || errors.length ? "cancelling" : "cancelled";
  state.cancellation = { ...loadJson(cancellationPath(state.state_root, state.run_id)), errors };
  state.updated_at = utcNow();
  writeJson2(statePath(state.state_root, state.run_id), state);
  if (state.run_state === "cancelled") {
    const driverFile = driverStatusPath(state.state_root, state.run_id);
    const driver = existsSync9(driverFile) ? loadJson(driverFile) : {};
    writeJson2(driverFile, {
      ...driver,
      run_id: state.run_id,
      status: "cancelled",
      counts: stateCounts(state),
      updated_at: utcNow()
    });
  }
  return { status: state.run_state, run_id: state.run_id, active: active.map((node) => node.id), errors, submitted: [] };
}
function pauseRequestPath(root, runId) {
  return path16.join(runDir(root, runId), "pause-request.json");
}
function readPauseIntent(root, runId) {
  const target = pauseRequestPath(root, runId);
  return existsSync9(target) ? loadJson(target) : null;
}
function parseControlReply(result, label) {
  if (!result || result.exit_code !== 0) return null;
  try {
    const data = pyJsonLoads(String(result.stdout ?? ""));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}
function controlFailureDetail(result) {
  return String(result?.stderr || result?.stdout || "").trim().slice(0, 300);
}
function runAsyncControl(operation, taskRoot, taskId, { expectedRevision = "", reason = "" } = {}) {
  const argv = [
    process8.execPath,
    ASYNC_SERVICE_PATH,
    "internal",
    operation,
    "--task-root",
    pyStr(taskRoot),
    "--task-id",
    pyStr(taskId)
  ];
  if (expectedRevision) argv.push("--expected-revision", pyStr(expectedRevision));
  if (reason) argv.push("--reason", pyStr(reason));
  const result = deps3.runCommand(argv, ROOT);
  return { reply: parseControlReply(result, `async internal ${operation}`), detail: controlFailureDetail(result) };
}
function settlePause(state, { reason = null } = {}) {
  const errors = [];
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  const intent = readPauseIntent(root, runId);
  const intentReason = pyStr(reason || intent?.reason || state.pause_request?.reason || "pause_requested");
  const recorded = new Set(
    [...intent?.task_ids ?? [], ...state.pause_request?.task_ids ?? []].map((item) => pyStr(item)).filter(Boolean)
  );
  const independent = new Set(
    [...intent?.independent_task_ids ?? [], ...state.pause_request?.independent_task_ids ?? []].map((item) => pyStr(item)).filter(Boolean)
  );
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  if (existsSync9(cancellationPath(root, runId))) {
    const cancellation = loadJson(cancellationPath(root, runId));
    const cancellationState = ["cancelled", "cancelling"].includes(pyStr(state.run_state)) ? pyStr(state.run_state) : "cancelling";
    return {
      run_id: runId,
      accepted: false,
      state: cancellationState,
      reason: "cancel_priority",
      paused_task_ids: [],
      pending_task_ids: [],
      next_step: `\u5DF2\u5B58\u5728\u53D6\u6D88\u8BF7\u6C42\uFF08${pyStr(cancellation?.reason || "")}\uFF09\uFF0C\u6682\u505C\u4E0D\u518D\u6267\u884C\uFF1B\u7528 status \u89C2\u5BDF\u53D6\u6D88\u6536\u655B\uFF0C\u53D6\u6D88\u5B8C\u6210\u540E\u9700\u8981\u7EE7\u7EED\u65F6\u6309\u65B0 run \u5904\u7406\u3002`
    };
  }
  if (nodes.length && nodes.every((node) => TERMINAL_STATES.has(node.state))) {
    const settled = driverOutcome({ ...state, run_state: "running" });
    state.run_state = settled;
    state.updated_at = utcNow();
    return {
      run_id: runId,
      accepted: true,
      state: settled,
      reason: "run_already_settled",
      paused_task_ids: [],
      pending_task_ids: []
    };
  }
  for (const node of nodes) {
    const taskId = pyStr(node.task_id || "");
    if (!taskId) continue;
    if (!(ACTIVE_STATES.has(node.state) || node.state === "paused")) continue;
    const taskRoot = nodeTaskRoot(state, node);
    const [statuses, failures] = asyncInternalBatch("get", taskRoot, [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (!status) {
      errors.push(`${pyStr(node.id)}: async get missing task ${taskId}`);
      continue;
    }
    if (status.state === "paused") {
      if (!recorded.has(taskId)) independent.add(taskId);
      applyAsyncStatus(node, status, "fleet_pause", state);
      continue;
    }
    if (!ACTIVE_STATES.has(status.state)) {
      applyAsyncStatus(node, status, "fleet_pause", state);
      continue;
    }
    if (node.pause_requested) continue;
    const control = runAsyncControl("pause", taskRoot, taskId, {
      expectedRevision: pyStr(status.revision),
      reason: intentReason
    });
    if (!control.reply) {
      errors.push(`${pyStr(node.id)}: internal pause \u672A\u53D6\u5F97\u56DE\u6267${control.detail ? `\uFF1A${control.detail}` : ""}`);
      continue;
    }
    node.pause_request_reason = pyStr(control.reply.reason || "");
    if (control.reply.reason === "already_paused") {
      independent.add(taskId);
      continue;
    }
    if (control.reply.accepted === false || control.reply.ok === false) {
      errors.push(`${pyStr(node.id)}: ${pyStr(control.reply.reason || "pause_rejected")}${control.reply.next_step ? ` \u2014 ${pyStr(control.reply.next_step)}` : ""}`);
      continue;
    }
    node.pause_requested = true;
    recorded.add(taskId);
  }
  const pausedTaskIds = [];
  const pendingTaskIds = [];
  for (const taskId of [...recorded]) {
    const node = nodes.find((item) => pyStr(item.task_id || "") === taskId);
    if (!node) {
      pendingTaskIds.push(taskId);
      continue;
    }
    const [statuses, failures] = asyncInternalBatch("get", nodeTaskRoot(state, node), [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (status) applyAsyncStatus(node, status, "fleet_pause", state);
    if (status?.state === "paused") pausedTaskIds.push(taskId);
    else if (!status || !TERMINAL_STATES.has(status.state)) pendingTaskIds.push(taskId);
  }
  const unmanagedActive = nodes.filter((node) => ACTIVE_STATES.has(node.state) && !pyStr(node.task_id || "")).map((node) => pyStr(node.id));
  const activeAny = nodes.some((node) => ACTIVE_STATES.has(node.state));
  const runState = pendingTaskIds.length || activeAny ? "pausing" : "paused";
  state.pause_request = {
    reason: intentReason,
    requested_at: pyStr(intent?.requested_at || state.pause_request?.requested_at || utcNow()),
    task_ids: [...recorded],
    independent_task_ids: [...independent],
    paused_task_ids: pausedTaskIds,
    pending_task_ids: pendingTaskIds,
    updated_at: utcNow()
  };
  state.run_state = runState;
  state.updated_at = utcNow();
  if (intent) {
    writeJson2(pauseRequestPath(root, runId), {
      ...intent,
      reason: intentReason,
      task_ids: [...recorded],
      independent_task_ids: [...independent],
      updated_at: utcNow()
    });
  }
  const receipt = {
    run_id: runId,
    accepted: true,
    state: runState,
    reason: pendingTaskIds.length ? "pause_requested" : recorded.size ? "pause_confirmed" : "pause_idle",
    paused_task_ids: pausedTaskIds,
    pending_task_ids: pendingTaskIds
  };
  if (errors.length) {
    receipt.errors = errors.slice(0, 20);
    receipt.next_step = PAUSE_UNCONFIRMED_NEXT_STEP;
  } else if (unmanagedActive.length) {
    receipt.next_step = `\u8282\u70B9 ${unmanagedActive.join(", ")} \u4E3A\u540C\u6B65\u6267\u884C\uFF0C\u4E0D\u80FD\u534F\u4F5C\u6682\u505C\uFF1B\u7B49\u5176\u672C\u8F6E\u7ED3\u675F\u4E14\u65E0\u5176\u4ED6\u6D3B\u52A8\u6267\u884C\u540E run \u624D\u8FDB\u5165 paused\u3002`;
  }
  return receipt;
}
function pauseRun(runId, root, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const text3 = String(reason || "").trim();
  if (!text3) throw new ToolError("pause reason is required");
  loadJson(statePath(resolvedRoot, runId));
  const intentPath = pauseRequestPath(resolvedRoot, runId);
  if (!existsSync9(intentPath)) {
    writeJson2(intentPath, { reason: text3, requested_at: utcNow(), task_ids: [], independent_task_ids: [] });
  }
  try {
    return runMutationLock(resolvedRoot, runId, () => {
      const state = loadJson(statePath(resolvedRoot, runId));
      state.resume_pending = false;
      const receipt = settlePause(state, { reason: text3 });
      writeJson2(statePath(resolvedRoot, runId), state);
      if (receipt.reason === "cancel_priority") rmSync4(intentPath, { force: true });
      return receipt;
    }, { timeoutSeconds: 15 });
  } catch (error) {
    if (!String(error.message).startsWith("fleet run mutation lock busy:")) throw error;
    return {
      run_id: runId,
      accepted: true,
      state: "pausing",
      reason: "waiting_for_inflight_operation",
      paused_task_ids: [],
      pending_task_ids: [],
      next_step: "\u8C03\u5EA6\u5668\u6B63\u5728\u5904\u7406\u672C\u8F6E\u6D3E\u53D1\uFF0C\u505C\u6D3E\u610F\u56FE\u5DF2\u843D\u76D8\uFF1Bdriver \u4E0B\u4E00\u8F6E tick \u4F1A\u7EE7\u7EED\u534F\u4F5C\u6682\u505C\uFF0C\u7528 status \u89C2\u5BDF\u6536\u655B\u3002"
    };
  }
}
function resumePausedTasks(state, intent) {
  const errors = [];
  const pendingTaskIds = [];
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  for (const rawTaskId of intent?.task_ids ?? []) {
    const taskId = pyStr(rawTaskId);
    if (!taskId) continue;
    const node = nodes.find((item) => pyStr(item.task_id || "") === taskId);
    if (!node) {
      pendingTaskIds.push(taskId);
      errors.push(`${taskId}: \u5DF2\u4E0D\u518D\u7ED1\u5B9A\u5230\u4EFB\u4F55\u8282\u70B9\uFF0C\u672A\u6062\u590D`);
      continue;
    }
    const taskRoot = nodeTaskRoot(state, node);
    const [statuses, failures] = asyncInternalBatch("get", taskRoot, [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (!status) {
      pendingTaskIds.push(taskId);
      errors.push(`${taskId}: async get missing task`);
      continue;
    }
    if (status.state !== "paused") {
      applyAsyncStatus(node, status, "fleet_resume", state);
      if (ACTIVE_STATES.has(status.state) && node.pause_requested) pendingTaskIds.push(taskId);
      continue;
    }
    const control = runAsyncControl("resume", taskRoot, taskId, { expectedRevision: pyStr(status.revision) });
    if (!control.reply || control.reply.ok === false || control.reply.accepted === false) {
      pendingTaskIds.push(taskId);
      const reason = control.reply ? pyStr(control.reply.reason || "resume_rejected") : `internal resume \u672A\u53D6\u5F97\u56DE\u6267${control.detail ? `\uFF1A${control.detail}` : ""}`;
      errors.push(`${taskId}: ${reason}`);
      continue;
    }
    node.pause_requested = false;
    node.pause_request_reason = null;
  }
  return { pending_task_ids: pendingTaskIds, errors };
}
function tickRun(runId, root, dryRun, verbose = false, { forceReconcile = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  return runMutationLock(resolvedRoot, runId, () => tickRunLocked(runId, resolvedRoot, dryRun, verbose, { forceReconcile }));
}
function tickRunLocked(runId, root, dryRun, verbose = false, { forceReconcile = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = loadJson(target);
  if (existsSync9(cancellationPath(resolvedRoot, runId))) {
    return dryRun ? { status: "cancelling", run_id: runId, submitted: [], dry_run: true } : settleCancellation(state);
  }
  const manifestSnapshot = pyStr(state.manifest_snapshot);
  const manifest = loadJson(manifestSnapshot);
  const validation = validateManifest(manifest);
  if (validation.status !== "ok") {
    throw new ToolError(`fleet manifest no longer validates: ${validation.errors.join("; ")}`);
  }
  const manifestById = /* @__PURE__ */ Object.create(null);
  for (const node of Array.isArray(manifest.nodes) ? manifest.nodes : []) {
    if (isRecord(node)) manifestById[nodeId(node)] = node;
  }
  const byId = indexNodes(state);
  for (const [nid, manifestNode] of Object.entries(manifestById)) {
    if (Object.hasOwn(byId, nid)) {
      if (!routeMatchesManifest(byId[nid], manifestNode)) {
        throw new ToolError(`frozen route identity changed for node ${nid}`);
      }
      byId[nid].dependency_policy = nodeDependencyPolicy(manifestNode);
      byId[nid].failure_policy = nodeFailurePolicy(manifestNode);
      byId[nid].resource_locks = nodeResourceLocks(manifestNode);
      byId[nid].is_reducer = nodeIsReducer(manifestNode);
      byId[nid].write_scope = nodeWriteScope(manifestNode);
    }
  }
  state.review_policy = effectiveReviewPolicy(manifest);
  state.run_state = "running";
  const refreshSummary = refreshActiveNodes(state, { forceReconcile });
  const acceptanceGateActions = enforceAcceptanceResultsGate(state, manifestById);
  if (acceptanceGateActions.length) refreshSummary.acceptance_results_gate = acceptanceGateActions;
  const allSettledUpdates = registerAllSettledConsumers(state);
  if (allSettledUpdates.length) refreshSummary.all_settled_updates = allSettledUpdates;
  const promotedDispatchFailures = promoteLegacyDispatchFailureBlocks(state);
  if (promotedDispatchFailures.length) refreshSummary.promoted_dispatch_failures = promotedDispatchFailures;
  const releasedDependencyBlocks = releaseResolvedDependencyBlocks(state, byId);
  if (releasedDependencyBlocks.length) refreshSummary.released_dependency_blocks = releasedDependencyBlocks;
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (!isRecord(node) || node.state !== "pending") continue;
    const badDep = blockedByFailedDependency(node, byId);
    if (badDep) {
      setNodeState(state, node, "blocked", {
        eventType: "agent_settled",
        businessState: "blocked",
        blocked_by: badDep,
        failure_fuse: true
      });
      node.blocked_by = badDep;
      node.failure_fuse = { status: "tripped", blocked_by: badDep };
      setFailureFuse(state, {
        nodeIdValue: pyStr(node.id || ""),
        reason: "failed_dependency",
        blocker: badDep
      });
    }
  }
  const submitted = [];
  const skipped = [];
  const activeScopes = activeWriteScopes(state);
  const activeResources = activeResourceLocks(state);
  let submittedThisTick = 0;
  const [layers] = topologicalLayers(Object.values(manifestById));
  const orderedIds = layers.flat();
  const readyIds = rebuildReadyQueue(state, Object.values(manifestById));
  const readySet = new Set(readyIds);
  for (const nid of orderedIds) {
    const node = byId[nid];
    if (!node || node.state !== "pending") continue;
    if (!readySet.has(nid)) skipped.push({ node_id: nid, reason: "waiting_for_dependencies" });
  }
  const queueWorking = [...readyIds];
  if (!dryRun && state.resume_pending && existsSync9(pauseRequestPath(resolvedRoot, runId))) {
    const resumeInfo = resumePausedTasks(state, readPauseIntent(resolvedRoot, runId));
    state.resume_status = resumeInfo;
    if (!resumeInfo.pending_task_ids.length) {
      rmSync4(pauseRequestPath(resolvedRoot, runId), { force: true });
      state.resume_pending = false;
      state.resume_status = null;
      state.pause_request = null;
      for (const node of state.nodes || []) {
        node.pause_requested = false;
        node.pause_request_reason = null;
      }
      writeJson2(target, state);
      return tickRunLocked(runId, resolvedRoot, false, verbose, { forceReconcile: true });
    }
  }
  if (existsSync9(pauseRequestPath(resolvedRoot, runId))) {
    const intent = readPauseIntent(resolvedRoot, runId);
    const receipt = dryRun ? { run_id: runId, accepted: true, state: "pausing", reason: "dry_run", paused_task_ids: [], pending_task_ids: [] } : state.resume_pending ? { run_id: runId, accepted: true, state: "pausing", reason: "resume_pending", ...state.resume_status, next_step: RESUME_SEAM_NEXT_STEP } : settlePause(state, { reason: intent?.reason ?? null });
    state.run_state = receipt.state;
    state.ready_queue = [...state.ready_queue || []].filter((nid) => (byId[nid] ?? {}).state === "pending");
    state.updated_at = utcNow();
    const pausedSkipped = (state.ready_queue || []).map((nid) => ({ node_id: nid, reason: "run_paused" }));
    if (dryRun) {
      return {
        status: "ok",
        dry_run: true,
        run_id: runId,
        paused: true,
        submitted: [],
        skipped: pausedSkipped,
        pause: receipt,
        ready_queue: [...state.ready_queue || []],
        state_path: rel(target)
      };
    }
    appendFleetEvent(state, "run_pause", null, {
      incrementNodeRevision: false,
      pause: receipt,
      skipped: pausedSkipped
    });
    writeJson2(target, state);
    return {
      status: "ok",
      dry_run: false,
      run_id: runId,
      paused: true,
      submitted: [],
      skipped: pausedSkipped,
      pause: receipt,
      ready_queue: [...state.ready_queue || []],
      state_path: rel(target)
    };
  }
  for (const nid of readyIds) {
    if (existsSync9(cancellationPath(resolvedRoot, runId)) || existsSync9(pauseRequestPath(resolvedRoot, runId))) break;
    const node = byId[nid];
    if (!node || node.state !== "pending") continue;
    const resourceOwner = resourceLocked(node, activeResources);
    if (resourceOwner) {
      skipped.push({ node_id: nid, reason: `resource_locked_by:${resourceOwner}` });
      continue;
    }
    const lockedBy = writeLocked(node, activeScopes);
    if (lockedBy) {
      skipped.push({ node_id: nid, reason: `write_locked_by:${lockedBy}` });
      continue;
    }
    const [ok, reason] = budgetAllows(node, state, submittedThisTick);
    if (!ok) {
      skipped.push({ node_id: nid, reason });
      continue;
    }
    const outcome = deps3.dispatchNode(state, manifest, node, manifestById[nid], { dryRun });
    if (outcome.status === "needs_parent_review") {
      if (node.resource_quarantined) {
        activeScopes.push([nid, [...node.write_scope || []]]);
        activeResources.push([nid, [...node.resource_locks || []]]);
      }
      skipped.push({ node_id: nid, reason: Object.hasOwn(outcome, "reason") ? outcome.reason : "requires_parent_review" });
      const index2 = queueWorking.indexOf(nid);
      if (index2 !== -1) queueWorking.splice(index2, 1);
      continue;
    }
    submitted.push(outcome);
    submittedThisTick += 1;
    const index = queueWorking.indexOf(nid);
    if (index !== -1 && (dryRun || outcome.status === "ok")) queueWorking.splice(index, 1);
    if (!dryRun && outcome.status === "ok" && !outcome.terminal) {
      activeScopes.push([nid, [...node.write_scope || []]]);
      activeResources.push([nid, [...node.resource_locks || []]]);
    }
  }
  state.ready_queue = queueWorking.filter((nid) => (byId[nid] ?? {}).state === "pending");
  state.ready_queue_revision = positiveInt(state.revision);
  state.updated_at = utcNow();
  const routeProvenanceUpdates = [];
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (!isRecord(node) || !TERMINAL_STATES.has(node.state)) continue;
    if (enrichTerminalRouteFromRuntime(node)) {
      const nodeIdValue = pyStr(node.id || "");
      routeProvenanceUpdates.push(nodeIdValue);
      appendFleetEvent(state, "route_provenance", node, {
        incrementNodeRevision: false,
        source: "terminal_runtime_artifacts",
        route: routeSnapshot(node)
      });
    }
  }
  if (routeProvenanceUpdates.length) refreshSummary.route_provenance_updates = routeProvenanceUpdates;
  settleFleetIfNeeded(state);
  const compactSubmitted = submitted.map((item) => compactDispatchOutcome(item));
  const returnedSubmitted = verbose ? submitted : compactSubmitted;
  let data;
  if (dryRun) {
    data = {
      status: "ok",
      dry_run: true,
      run_id: runId,
      detail_level: verbose ? "full" : "compact",
      submitted: returnedSubmitted,
      skipped,
      ready_queue: [...state.ready_queue || []],
      state_path: rel(target)
    };
  } else {
    appendFleetEvent(state, "tick", null, {
      incrementNodeRevision: false,
      refresh: refreshSummary,
      submitted: compactSubmitted,
      skipped
    });
    state.ready_queue_revision = positiveInt(state.revision);
    writeJson2(target, state);
    data = {
      status: "ok",
      dry_run: false,
      run_id: runId,
      detail_level: verbose ? "full" : "compact",
      refresh: refreshSummary,
      submitted: returnedSubmitted,
      skipped,
      ready_queue: [...state.ready_queue || []],
      event_cursor: `${runId}+${positiveInt(state.event_revision)}`,
      state_path: rel(target)
    };
  }
  return data;
}
function waitRun(runId, root, waitMs, { verbose = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = loadJson(target);
  const waited = waitForCompletionNotices(state, waitMs);
  const data = { run_id: runId, state_path: rel(target), ...waited };
  if (waited.event === "completion_notice") {
    data.tick = tickRun(runId, resolvedRoot, false, verbose);
  }
  return data;
}
function resumeRun(runId, root, { dryRun = false, verbose = false } = {}) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  return runMutationLock(resolvedRoot, runId, () => {
    const before = loadJson(statePath(resolvedRoot, runId));
    const activeBefore = sortedStrings2(
      (Array.isArray(before.nodes) ? before.nodes : []).filter((node) => isRecord(node) && ACTIVE_STATES.has(node.state) && node.task_id).map((node) => pyStr(node.id || ""))
    );
    const intent = readPauseIntent(resolvedRoot, runId);
    let resumeInfo = null;
    if (intent && dryRun) return {
      ...buildStatusSummary(before),
      accepted: false,
      state: before.run_state,
      reason: "dry_run",
      resumed: false
    };
    if (intent && (existsSync9(cancellationPath(resolvedRoot, runId)) || before.cancel_request)) return {
      ...tickRunLocked(runId, resolvedRoot, false, verbose),
      accepted: false,
      state: "cancelling",
      reason: "cancel_priority",
      resumed: false
    };
    if (intent) {
      resumeInfo = resumePausedTasks(before, intent);
      if (resumeInfo.pending_task_ids.length) {
        before.run_state = "pausing";
        before.resume_pending = true;
        before.resume_status = resumeInfo;
        writeJson2(statePath(resolvedRoot, runId), before);
        return {
          run_id: runId,
          accepted: true,
          resumed: false,
          state: "pausing",
          reason: "resume_pending",
          pending_task_ids: resumeInfo.pending_task_ids,
          errors: resumeInfo.errors,
          paused_task_ids: before.nodes.filter((node) => node.state === "paused").map((node) => node.task_id),
          next_step: RESUME_SEAM_NEXT_STEP
        };
      }
      rmSync4(pauseRequestPath(resolvedRoot, runId), { force: true });
      before.run_state = "running";
      before.resume_pending = false;
      before.resume_status = null;
      before.pause_request = null;
      for (const node of Array.isArray(before.nodes) ? before.nodes : []) {
        if (!isRecord(node)) continue;
        node.pause_requested = false;
        node.pause_request_reason = null;
      }
      writeJson2(statePath(resolvedRoot, runId), before);
    }
    const data = tickRunLocked(runId, resolvedRoot, dryRun, verbose, { forceReconcile: true });
    data.resumed = true;
    data.active_before = activeBefore;
    data.reconcile_requested = Boolean(activeBefore.length);
    data.duplicate_submission_guard = true;
    const after = loadJson(statePath(resolvedRoot, runId));
    const afterRunState = pyStr(after.run_state || "");
    const pendingTaskIds = resumeInfo?.pending_task_ids ?? [];
    Object.assign(data, {
      run_id: runId,
      accepted: true,
      state: ["cancelled", "cancelling", "completed", "blocked", "needs_parent_review", "failed"].includes(afterRunState) ? afterRunState : pendingTaskIds.length ? "paused" : "running",
      reason: intent ? pendingTaskIds.length ? "resume_pending" : "resume_accepted" : "no_pause_request",
      paused_task_ids: (Array.isArray(after.nodes) ? after.nodes : []).filter((node) => isRecord(node) && node.state === "paused" && pyStr(node.task_id || "")).map((node) => pyStr(node.task_id)),
      pending_task_ids: pendingTaskIds
    });
    if (resumeInfo?.errors.length) {
      data.errors = resumeInfo.errors.slice(0, 20);
      data.next_step = RESUME_SEAM_NEXT_STEP;
    }
    return data;
  });
}
function driverOutcome(state) {
  if (["cancelled", "cancelling"].includes(state.run_state)) return state.run_state;
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  if (["paused", "pausing"].includes(state.run_state) && nodes.some((node) => !TERMINAL_STATES.has(node.state))) {
    return state.run_state;
  }
  if (nodes.some((node) => ACTIVE_STATES.has(node.state))) return "running";
  const pausedHold = nodes.some((node) => node.state === "paused");
  if (nodes.some((node) => !TERMINAL_STATES.has(node.state))) {
    if (nodes.some((node) => node.state === "needs_parent_review" && !truthyList(node.all_settled_consumers))) {
      return "needs_parent_review";
    }
    if (pausedHold && !nodes.some((node) => node.state === "pending" || node.state === "ready")) {
      return "paused";
    }
    return "ready";
  }
  if (nodes.some((node) => node.state === "needs_parent_review" && !truthyList(node.all_settled_consumers))) {
    return "needs_parent_review";
  }
  if (nodes.some((node) => ["failed", "cancelled", "blocked"].includes(node.state) && !truthyList(node.all_settled_consumers))) {
    return "blocked";
  }
  return "completed";
}
function truthyList(value) {
  if (value === null || value === void 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}
function writeDriverStatus(root, runId, data) {
  const currentPath = driverStatusPath(root, runId);
  const previous = existsSync9(currentPath) ? loadJson(currentPath) : {};
  writeJson2(currentPath, {
    ...previous,
    run_id: runId,
    pid: process8.pid,
    updated_at: utcNow(),
    ...data
  });
  return null;
}
function persistDriverOutcome(root, runId, outcome, error = null) {
  runMutationLock(root, runId, () => {
    const target = statePath(root, runId);
    const state = loadJson(target);
    const changed = state.run_state !== outcome || state.driver_error !== error;
    state.run_state = outcome;
    state.driver_error = error;
    if (changed) appendFleetEvent(state, "driver_status", null, {
      incrementNodeRevision: false,
      error,
      attention_required: outcome !== "completed"
    });
    writeJson2(target, state);
  });
}
function driveRun(runId, root, waitMs) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  if (waitMs < 1e3 || waitMs > 6e5) throw new ToolError("driver wait_ms must be between 1000 and 600000");
  const target = statePath(resolvedRoot, runId);
  loadJson(target);
  writeDriverStatus(resolvedRoot, runId, { status: "running", started_at: utcNow(), error: null });
  let ticks = 0;
  let idleReadyTicks = 0;
  try {
    for (; ; ) {
      const tickData = tickRun(runId, resolvedRoot, false);
      ticks += 1;
      const state = loadJson(target);
      const outcome = driverOutcome(state);
      if (["completed", "blocked", "needs_parent_review", "cancelled"].includes(outcome)) {
        const data = {
          status: outcome,
          run_id: runId,
          ticks,
          counts: stateCounts(state),
          state_path: rel(target),
          driver_status_path: rel(driverStatusPath(resolvedRoot, runId)),
          finished_at: utcNow()
        };
        persistDriverOutcome(resolvedRoot, runId, outcome);
        writeDriverStatus(resolvedRoot, runId, data);
        return data;
      }
      if (outcome === "running") {
        writeDriverStatus(resolvedRoot, runId, { status: "running", resume_pending: false, pause: null });
        idleReadyTicks = 0;
        waitRun(runId, resolvedRoot, waitMs);
        continue;
      }
      if (outcome === "cancelling") {
        writeDriverStatus(resolvedRoot, runId, { status: outcome, ticks, counts: stateCounts(state) });
        deps3.sleep(Math.min(waitMs / 1e3, 1));
        continue;
      }
      if (outcome === "paused" || outcome === "pausing") {
        persistDriverOutcome(resolvedRoot, runId, outcome);
        writeDriverStatus(resolvedRoot, runId, {
          status: outcome,
          resume_pending: Boolean(state.resume_pending),
          pause: tickData.pause ?? null,
          ticks
        });
        idleReadyTicks = 0;
        deps3.sleep(Math.min(waitMs / 1e3, 1));
        continue;
      }
      if (outcome === "ready") {
        const pausedHold = (state.nodes || []).some((node) => isRecord(node) && node.state === "paused");
        if (truthyList(tickData.submitted) || pausedHold) {
          idleReadyTicks = 0;
          if (!truthyList(tickData.submitted)) deps3.sleep(0.5);
        } else {
          idleReadyTicks += 1;
          if (idleReadyTicks >= 3) throw new ToolError("fleet driver stalled with ready nodes making no progress");
          deps3.sleep(0.5);
        }
        continue;
      }
      throw new ToolError("fleet driver stalled with pending nodes but no active or review-gated node");
    }
  } catch (error) {
    persistDriverOutcome(resolvedRoot, runId, "failed", String(error?.message ?? error));
    writeDriverStatus(resolvedRoot, runId, {
      status: "failed",
      error: String(error?.message ?? error),
      finished_at: utcNow()
    });
    throw error;
  }
}
async function launchDriverImpl(runId, root, waitMs) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const lock = await acquireRunLockAsync(resolvedRoot, runId);
  try {
    return await launchDriverLocked(runId, resolvedRoot, waitMs);
  } finally {
    releaseRunLock(lock);
  }
}
function launchDriver(runId, root, waitMs) {
  return deps3.launchDriver(runId, root, waitMs);
}
async function launchDriverLocked(runId, root, waitMs) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = loadJson(target);
  if (existsSync9(cancellationPath(resolvedRoot, runId)) && state.run_state === "cancelled") return { status: "cancelled", run_id: runId, started: false };
  const statusFile = driverStatusPath(resolvedRoot, runId);
  const existing = existsSync9(statusFile) ? loadJson(statusFile) : {};
  if (["running", "cancelling", "paused", "pausing"].includes(existing.status) && deps3.processAlive(existing.pid)) {
    return {
      status: "ok",
      run_id: runId,
      pid: existing.pid ?? null,
      reused: true,
      state_path: rel(target),
      driver_status_path: rel(statusFile),
      log_path: rel(driverLogPath(resolvedRoot, runId))
    };
  }
  const logPath = driverLogPath(resolvedRoot, runId);
  mkdirSync8(path16.dirname(logPath), { recursive: true });
  const command = [
    process8.execPath,
    SCHEDULER_CLI_PATH,
    "drive",
    "--run-id",
    runId,
    "--state-root",
    resolvedRoot,
    "--wait-ms",
    pyStr(waitMs),
    "--format",
    "json"
  ];
  const log = openSync5(logPath, "a");
  let child;
  try {
    child = deps3.spawnDriver(command[0], command.slice(1), {
      cwd: ROOT,
      stdio: ["ignore", log, log],
      detached: true,
      windowsHide: true
    });
  } finally {
    closeSync5(log);
  }
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();
  const failedToStart = () => spawnError || child.signalCode !== null || child.exitCode !== null && child.exitCode !== 0;
  const startDeadline = Date.now() + 1e4;
  while (!failedToStart() && child.exitCode === null && Date.now() < startDeadline) {
    await delay(50);
    if (existsSync9(statusFile) && loadJson(statusFile).pid === child.pid) break;
  }
  if (failedToStart()) {
    const tail2 = readFileSync10(logPath, "utf8").slice(-1200);
    throw new ToolError(`fleet driver failed to start: ${spawnError?.message || child.signalCode || ""}${tail2}`);
  }
  const latest = existsSync9(statusFile) ? loadJson(statusFile) : {};
  if (latest.pid !== child.pid) {
    writeJson2(statusFile, {
      run_id: runId,
      pid: child.pid,
      status: "running",
      started_at: utcNow(),
      updated_at: utcNow(),
      error: null
    });
  }
  return {
    status: "ok",
    run_id: runId,
    pid: child.pid,
    reused: false,
    state_path: rel(target),
    driver_status_path: rel(statusFile),
    log_path: rel(logPath)
  };
}
function stateCounts(state) {
  const counts = /* @__PURE__ */ Object.create(null);
  for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
    if (isRecord(node)) {
      const nodeState = pyStr(node.state || "unknown");
      counts[nodeState] = (counts[nodeState] ?? 0) + 1;
    }
  }
  return counts;
}
function shortText(value, limit = 220) {
  const text3 = pyStrip(pyStr(value).split("\r").join(" ").split("\n").join(" "));
  if (text3.length <= limit) return text3;
  return `${pyRStrip(text3.slice(0, limit - 3))}...`;
}
function compactNode(node) {
  const data = {
    id: node.id ?? null,
    state: node.state ?? null,
    kind: node.kind ?? null,
    role: node.role ?? null,
    route_id: node.route_id ?? null,
    route: routeSnapshot(node),
    route_source: node.route_source ?? null,
    dependency_policy: node.dependency_policy ?? null,
    failure_policy: node.failure_policy ?? null,
    resource_locks: node.resource_locks ?? null,
    is_reducer: node.is_reducer ?? null,
    revision: Object.hasOwn(node, "revision") ? node.revision : 0,
    task_id: node.task_id ?? null,
    updated_at: node.updated_at ?? null
  };
  for (const key of [
    "blocked_by",
    "review_required",
    "review_decision",
    "reviewed_at",
    "review_deferred_to",
    "all_settled_consumers",
    "next_liveness_check_at",
    "review_round",
    "superseded_task_ids",
    "warnings"
  ]) {
    if (notEmptyPy(node[key])) data[key] = node[key];
  }
  const lastStatus = node.last_status;
  if (isRecord(lastStatus)) {
    for (const key of [
      "source",
      "contract_state",
      "business_state",
      "business_state_raw",
      "artifact_state",
      "requires_parent_review",
      "cancel_reason",
      "failure_type",
      "turn_status",
      "exit_code",
      "signal",
      "error",
      "process_alive",
      "completion_notice_path",
      "report_path",
      "handoff_path",
      "declared_report_path",
      "business_report_path",
      "salvage_report_path",
      "salvage_evidence_paths",
      "live_path",
      "last_progress_line",
      // 运行项只展示遥测，不从时长、工具次数或静默推导异常。
      "elapsed_seconds",
      "live_age_seconds",
      "tool_call_count",
      "last_tool_kind",
      "progress_state"
    ]) {
      if (notEmptyPy(lastStatus[key])) {
        const value = lastStatus[key];
        data[key] = typeof value === "string" ? shortText(value) : value;
      }
    }
  }
  if (["accepted", "blocked"].includes(node.review_decision)) {
    data.review_gate = node.review_decision === "accepted" ? "pass" : "fail";
    data.requires_parent_review = false;
  } else if (isRecord(lastStatus) && lastStatus.review_gate) {
    data.review_gate = lastStatus.review_gate;
  }
  const review = node.review;
  if (isRecord(review)) {
    const projected = {};
    for (const [key, value] of Object.entries(review)) {
      if (!["decision", "evidence_path", "reason", "reviewed_at"].includes(key)) continue;
      if (value === null || value === void 0 || value === "") continue;
      projected[key] = typeof value === "string" ? shortText(value) : value;
    }
    data.review = projected;
  }
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (notEmptyPy(value) || key === "requires_parent_review" && ["accepted", "blocked"].includes(node.review_decision)) out[key] = value;
  }
  return out;
}
function compactEvent(event) {
  const data = {};
  for (const key of [
    "at",
    "timestamp",
    "type",
    "run_id",
    "node_id",
    "task_id",
    "revision",
    "node_revision",
    "fleet_revision",
    "cursor",
    "state",
    "business_state",
    "decision",
    "evidence_path",
    "source",
    "reason",
    "review_round",
    "fuse_tripped",
    "route",
    "route_source",
    "requested_route",
    "actual_route",
    "usage_provenance",
    "error",
    "attention_required"
  ]) {
    if (notEmptyPy(event[key])) data[key] = event[key];
  }
  for (const key of ["submitted", "skipped"]) {
    const value = event[key];
    if (Array.isArray(value)) data[`${key}_count`] = value.length;
  }
  const refresh = event.refresh;
  if (isRecord(refresh)) {
    const projected = {};
    for (const key of [
      "active",
      "inbox",
      "queried",
      "reconciled",
      "inspection_deferred",
      "released_dependency_blocks",
      "all_settled_updates",
      "errors"
    ]) {
      if (notEmptyPy(refresh[key])) projected[key] = refresh[key];
    }
    data.refresh = projected;
  }
  return data;
}
function loadManifestSnapshotForStatus(state) {
  const pathText = state.manifest_snapshot;
  if (!pathText) return null;
  const resolved = requireRepoInternal(resolveUnder(pyStr(pathText), ROOT), "manifest snapshot");
  if (!existsSync9(resolved)) return null;
  return loadJson(resolved);
}
function orderedPendingIds(state, manifest) {
  const byId = indexNodes(state);
  const pendingIds = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node) && node.state === "pending").map((node) => pyStr(node.id ?? null));
  if (!manifest) return pendingIds;
  const manifestNodesList = (Array.isArray(manifest.nodes) ? manifest.nodes : []).filter((node) => isRecord(node));
  let layers;
  try {
    [layers] = topologicalLayers(manifestNodesList);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    return pendingIds;
  }
  const layerIndex = /* @__PURE__ */ Object.create(null);
  layers.forEach((layer, index) => {
    for (const nid of layer) layerIndex[nid] = index;
  });
  const criticality = downstreamCounts(manifestNodesList);
  const ordered = layers.flat().filter((nid) => Object.hasOwn(byId, nid) && byId[nid].state === "pending");
  const seen = new Set(ordered);
  for (const nid of pendingIds) {
    if (!seen.has(nid)) ordered.push(nid);
  }
  ordered.sort((left, right) => {
    const leftKey = [-(criticality[left] ?? 0), layerIndex[left] ?? 0, left];
    const rightKey = [-(criticality[right] ?? 0), layerIndex[right] ?? 0, right];
    for (let i = 0; i < 3; i += 1) {
      if (leftKey[i] < rightKey[i]) return -1;
      if (leftKey[i] > rightKey[i]) return 1;
    }
    return 0;
  });
  return ordered;
}
function nextReadySummary(state, manifest) {
  const byId = indexNodes(state);
  const activeScopes = activeWriteScopes(state);
  const ready = [];
  const blockedReady = [];
  let submittedThisTick = 0;
  for (const nid of orderedPendingIds(state, manifest)) {
    const node = byId[nid];
    if (!node) continue;
    const badDep = blockedByFailedDependency(node, byId);
    if (badDep) {
      blockedReady.push({ id: nid, reason: `blocked_dependency:${badDep}` });
      continue;
    }
    if (!dependenciesReady(node, byId)) continue;
    const lockedBy = writeLocked(node, activeScopes);
    if (lockedBy) {
      blockedReady.push({ id: nid, reason: `write_locked_by:${lockedBy}` });
      continue;
    }
    const [ok, reason] = budgetAllows(node, state, submittedThisTick);
    if (!ok) {
      blockedReady.push({ id: nid, reason });
      continue;
    }
    ready.push(compactNode(node));
    submittedThisTick += 1;
    activeScopes.push([nid, [...node.write_scope || []]]);
    if (ready.length >= SUMMARY_NODE_LIMIT) break;
  }
  return [ready, blockedReady.slice(0, SUMMARY_NODE_LIMIT)];
}
function buildStatusSummary(state, manifest) {
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  const counts = stateCounts(state);
  const active = nodes.filter((node) => ACTIVE_STATES.has(node.state)).map((node) => compactNode(node));
  const needsReview = nodes.filter((node) => node.state === "needs_parent_review" && !truthyList(node.all_settled_consumers)).map((node) => compactNode(node));
  const paused = nodes.filter((node) => node.state === "paused").map((node) => compactNode(node));
  const aggregatedInputs = nodes.filter((node) => truthyList(node.all_settled_consumers)).map((node) => compactNode(node));
  const failedOrBlocked = nodes.filter((node) => ["failed", "cancelled", "blocked"].includes(node.state) && !truthyList(node.all_settled_consumers)).map((node) => compactNode(node));
  const recentCompleted = stableSortDesc(
    nodes.filter((node) => node.state === "done").map((node) => compactNode(node)),
    (node) => pyStr(node.updated_at || "")
  ).slice(0, SUMMARY_NODE_LIMIT);
  const [nextReady, blockedReady] = nextReadySummary(state, manifest);
  const events = Array.isArray(state.events) ? state.events : [];
  const recentEvents = events.slice(-SUMMARY_EVENT_LIMIT).filter((event) => isRecord(event)).map((event) => compactEvent(event));
  return {
    total: nodes.length,
    counts,
    run_state: state.state_root && state.run_id && existsSync9(cancellationPath(state.state_root, state.run_id)) ? state.run_state === "cancelled" ? "cancelled" : "cancelling" : state.run_state ?? null,
    ...state.cancellation ? { cancellation: { ...state.cancellation, errors: (state.cancellation.errors || []).slice(0, SUMMARY_NODE_LIMIT) } } : {},
    revision: Object.hasOwn(state, "revision") ? state.revision : 0,
    event_revision: Object.hasOwn(state, "event_revision") ? state.event_revision : 0,
    ready_queue: [...state.ready_queue || []].slice(0, SUMMARY_NODE_LIMIT),
    failure_fuse: isRecord(state.failure_fuse) ? state.failure_fuse : {},
    review_policy: isRecord(state.review_policy) ? state.review_policy : {},
    active: active.slice(0, SUMMARY_NODE_LIMIT),
    needs_review: needsReview.slice(0, SUMMARY_NODE_LIMIT),
    paused: paused.slice(0, SUMMARY_NODE_LIMIT),
    aggregated_inputs: aggregatedInputs.slice(0, SUMMARY_NODE_LIMIT),
    recent_completed: recentCompleted,
    failed_or_blocked: failedOrBlocked.slice(0, SUMMARY_NODE_LIMIT),
    next_ready: nextReady,
    ready_blocked: blockedReady,
    recent_events: recentEvents,
    manifest_available: manifest !== null && manifest !== void 0,
    ...nodes.some((node) => node.warnings?.length) ? {
      warning_node_count: nodes.filter((node) => node.warnings?.length).length,
      warnings: nodes.filter((node) => node.warnings?.length).slice(0, SUMMARY_NODE_LIMIT).map((node) => ({ node_id: node.id, warnings: node.warnings }))
    } : {}
  };
}
function stableSortDesc(items, keyOf) {
  return items.map((item, index) => [item, index]).sort((left, right) => {
    const lk = keyOf(left[0]);
    const rk = keyOf(right[0]);
    if (lk < rk) return 1;
    if (lk > rk) return -1;
    return left[1] - right[1];
  }).map(([item]) => item);
}
function formatStatusSummary(data) {
  const summary = isRecord(data.summary) ? data.summary : {};
  const counts = isRecord(summary.counts) ? summary.counts : {};
  const parts = [
    `counts=${pyJsonDumps(canonicalValue(counts))}`,
    `active=${(summary.active || []).length}`,
    `paused=${(summary.paused || []).length}`,
    `needs_review=${(summary.needs_review || []).length}`,
    `next_ready=${(summary.next_ready || []).length}`,
    `failed_or_blocked=${(summary.failed_or_blocked || []).length}`
  ];
  return `fleet status summary ok: ${parts.join(" ")}`;
}
function statusRun(runId, root, summary = false) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const target = statePath(resolvedRoot, runId);
  const state = loadJson(target);
  const data = { status: "ok", run_id: runId, counts: stateCounts(state), state_path: rel(target) };
  if (summary) {
    const manifest = loadManifestSnapshotForStatus(state);
    data.summary = buildStatusSummary(state, manifest);
    return data;
  }
  data.state = state;
  return data;
}
var DEFAULT_STATE_ROOT, DEFAULT_ASYNC_TASK_ROOT, TERMINAL_STATES, ASYNC_TERMINAL_STATES, ACTIVE_STATES, FAILED_DEPENDENCY_STATES, SUMMARY_NODE_LIMIT, SUMMARY_EVENT_LIMIT, SAFE_ID_RE, INITIAL_LIVENESS_GRACE_SECONDS, RUN_LOCK_TIMEOUT_SECONDS, LIVENESS_RECHECK_SECONDS, DISPATCH_PREPARE_TIMEOUT_SECONDS, MAX_RUNTIME_EVIDENCE_BYTES, MAX_RUNTIME_USAGE_VALUE, RUNTIME_USAGE_FIELDS, ROUTE_KEYS, SCHEDULER_CLI_PATH, DISPATCH_PREPARE_PATH, ASYNC_SERVICE_PATH, deps3, BUSINESS_STATE_BY_NODE_STATE, ACCEPTANCE_RESULTS_BLOCK, PAUSE_UNCONFIRMED_NEXT_STEP, RESUME_SEAM_NEXT_STEP;
var init_fleet_scheduler = __esm({
  async "ops/tools/dispatch-core/fleet_scheduler.mjs"() {
    init_file_lock();
    init_shared();
    init_tool_common();
    init_py();
    await init_fleet_manifest_check();
    DEFAULT_STATE_ROOT = path16.join(ROOT, ".runtime", "cockpit", "fleet_runs");
    DEFAULT_ASYNC_TASK_ROOT = path16.join(ROOT, ".runtime", "cockpit", "async_tasks");
    TERMINAL_STATES = /* @__PURE__ */ new Set(["done", "failed", "cancelled", "blocked", "needs_parent_review"]);
    ASYNC_TERMINAL_STATES = /* @__PURE__ */ new Set(["done", "failed", "cancelled"]);
    ACTIVE_STATES = /* @__PURE__ */ new Set(["submitted", "queued", "running", "cancel_requested"]);
    FAILED_DEPENDENCY_STATES = /* @__PURE__ */ new Set(["failed", "cancelled", "blocked"]);
    SUMMARY_NODE_LIMIT = 8;
    SUMMARY_EVENT_LIMIT = 8;
    SAFE_ID_RE = /[^A-Za-z0-9_.-]+/g;
    INITIAL_LIVENESS_GRACE_SECONDS = 10 * 60;
    RUN_LOCK_TIMEOUT_SECONDS = 30;
    LIVENESS_RECHECK_SECONDS = 5 * 60;
    DISPATCH_PREPARE_TIMEOUT_SECONDS = 5 * 60;
    MAX_RUNTIME_EVIDENCE_BYTES = 128 * 1024;
    MAX_RUNTIME_USAGE_VALUE = 2147483647;
    RUNTIME_USAGE_FIELDS = [
      "total_tokens",
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
      "model_context_window"
    ];
    ROUTE_KEYS = ["executor", "model", "effort"];
    SCHEDULER_CLI_PATH = process8.argv[1] && /^fleet_scheduler(?:\.bundle)?\.mjs$/.test(path16.basename(process8.argv[1])) ? path16.resolve(process8.argv[1]) : path16.join(path16.dirname(path16.dirname(fileURLToPath3(import.meta.url))), "fleet_scheduler.mjs");
    DISPATCH_PREPARE_PATH = existsSync9(path16.join(RUNTIME_ROOT, "ops/dist/dispatch_prepare.bundle.mjs")) ? path16.join(RUNTIME_ROOT, "ops/dist/dispatch_prepare.bundle.mjs") : path16.join(RUNTIME_ROOT, "ops/tools/dispatch_prepare.mjs");
    ASYNC_SERVICE_PATH = existsSync9(path16.join(RUNTIME_ROOT, "ops/tools/subagent_service.mjs")) ? path16.join(RUNTIME_ROOT, "ops/tools/subagent_service.mjs") : path16.join(RUNTIME_ROOT, "ops/dist/subagent_service.bundle.mjs");
    deps3 = {
      runCommand: runCommandImpl,
      asyncInternalBatch: asyncInternalBatchImpl,
      processAlive: processAliveImpl,
      bootTimeMs: () => Date.now() - Math.round(uptime() * 1e3),
      dispatchNode: dispatchNodeImpl,
      launchDriver: launchDriverImpl,
      spawnDriver: spawn2,
      sleep: sleepSeconds,
      monotonic: monotonicSeconds
    };
    BUSINESS_STATE_BY_NODE_STATE = {
      done: "completed",
      failed: "failed",
      cancelled: "cancelled",
      blocked: "blocked",
      needs_parent_review: "needs_owner",
      running: "running",
      queued: "queued",
      submitted: "submitted",
      pending: "pending"
    };
    ACCEPTANCE_RESULTS_BLOCK = /```json[ \t]+acceptance_results[^\n]*\n([\s\S]*?)\n```/i;
    PAUSE_UNCONFIRMED_NEXT_STEP = "\u5DF2\u767B\u8BB0\u7684\u6682\u505C\u8BF7\u6C42\u5C1A\u672A\u786E\u8BA4\u505C\u6B62\uFF1A\u7528 status \u89C2\u5BDF\u6536\u655B\uFF0C\u6216\u7B49\u4EFB\u52A1\u4F1A\u8BDD\u4FDD\u5B58\u5B8C\u6210\uFF1BFleet \u4E0D\u81EA\u52A8\u5F3A\u6740\uFF0C\u4E5F\u4E0D\u91CA\u653E\u672A\u505C\u6B62\u4EFB\u52A1\u7684\u5199\u57DF\uFF1B\u786E\u5B9E\u9700\u8981\u7EC8\u6B62\u8BF7\u663E\u5F0F cancel\u3002";
    RESUME_SEAM_NEXT_STEP = "\u6062\u590D\u5C1A\u672A\u5B8C\u6210\uFF0C\u505C\u6D3E\u610F\u56FE\u548C\u672A\u6062\u590D\u4EFB\u52A1\u5DF2\u4FDD\u7559\uFF1B\u6839\u636E errors \u6392\u9664\u539F\u56E0\u540E\u91CD\u8BD5 resume\u3002";
  }
});

// ops/tools/fleet_scheduler.selftest.mjs
import { existsSync as existsSync10, mkdirSync as mkdirSync9, mkdtempSync, rmSync as rmSync5, writeFileSync as writeFileSync7 } from "node:fs";
import path17 from "node:path";
import process9 from "node:process";
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function deepEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function selfTestScanSeed(goal, reads) {
  return {
    route_id: "explorer-agent__codebase-scan",
    goal,
    scope: { read: [...reads] },
    contract: { scan_mode: "slice_scan", focus: "structure", question: "self-test" }
  };
}
function selfTestTwoNodeManifest() {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-scheduler-self-test",
    budget: { max_running_total: 2, max_submitted_per_tick: 2 },
    nodes: [
      { id: "scan-a", seed: selfTestScanSeed("self-test scan A", ["ops/tools"]) },
      {
        id: "scan-b",
        depends_on: ["scan-a"],
        seed: selfTestScanSeed("self-test scan B", ["ops/policies"])
      }
    ]
  };
}
function stMutationLock(root) {
  let serialized;
  runMutationLock(root, "lock-self-test", () => {
    try {
      runMutationLock(root, "lock-self-test", () => {
      }, { timeoutSeconds: 0.05 });
      serialized = false;
    } catch (error) {
      serialized = String(error?.message ?? error).includes("mutation lock busy");
    }
  }, { timeoutSeconds: 0.1 });
  return { concurrent_tick_is_serialized: serialized };
}
function stPrimaryRun(root, manifestFile, reviewEvidence) {
  const dispatchOverrideFixture = normalizeDispatchOverrides("isolated");
  const started = startRun(manifestFile, "", root, false, dispatchOverrideFixture);
  const ticked = tickRun(started.run_id, root, true);
  const verboseTicked = tickRun(started.run_id, root, true, true);
  const wouldRun = verboseTicked.submitted[0].dispatch.would_run;
  const fullOutcomeSample = {
    status: "ok",
    node_id: "sample-node",
    task_id: "sample-task",
    dispatch: {
      delivery_mode: "async_subagent",
      model: "sample-model",
      effort: "medium",
      package_id: "sample-package",
      task_package_path: "tmp/dispatch_prepare/sample.task-package.json",
      spawn_payload: "large transport material that must stay out of default tick output",
      business_output: {
        expected_report_path: "notes/explorer/sample.md",
        expected_handoff_path: "notes/handoffs/sample.md"
      }
    }
  };
  const compactOutcomeSample = compactDispatchOutcome(fullOutcomeSample);
  const state = loadJson(statePath(root, started.run_id));
  const scanA = indexNodes(state)["scan-a"];
  const taskRoot = path17.join(runDir(root, started.run_id), "async_tasks");
  scanA.state = "running";
  scanA.task_id = "task-self-test-a";
  scanA.task_root = taskRoot;
  const inbox = asyncCompletionInbox(taskRoot);
  mkdirSync9(inbox, { recursive: true });
  writeJson2(path17.join(inbox, "task-self-test-a.json"), {
    task_id: "task-self-test-a",
    state: "done",
    write_domain_scope_compliant: false,
    requires_parent_review: true,
    report_path: path17.join(root, "report.md"),
    handoff_path: path17.join(root, "handoff.md")
  });
  const waitedNotice = waitForCompletionNotices(state, 0);
  const timeoutState = {
    state_root: root,
    run_id: started.run_id,
    nodes: [
      {
        id: "timeout-node",
        state: "running",
        task_id: "task-without-notice",
        task_root: taskRoot
      }
    ]
  };
  const waitedTimeout = waitForCompletionNotices(timeoutState, 0);
  const refreshSummary = refreshActiveNodes(state);
  writeJson2(statePath(root, started.run_id), state);
  const tickWhileReviewPending = tickRun(started.run_id, root, false);
  const reviewPendingState = loadJson(statePath(root, started.run_id));
  const reviewPendingScanB = indexNodes(reviewPendingState)["scan-b"];
  const summaryBeforeReview = statusRun(started.run_id, root, true);
  const acceptedReview = reviewRun(
    started.run_id,
    root,
    "scan-a",
    "accepted",
    reviewEvidence,
    "self-test accept"
  );
  const tickAfterReview = tickRun(started.run_id, root, true);
  const summaryAfterReview = statusRun(started.run_id, root, true);
  const acceptedState = loadJson(statePath(root, started.run_id));
  const acceptedScanA = indexNodes(acceptedState)["scan-a"];
  return {
    start_ok: started.status === "ok",
    tick_dry_run_ok: ticked.status === "ok" && ticked.dry_run === true,
    autodrive_tasks_share_cockpit_root_and_run_batch: wouldRun.includes("--batch-id") && wouldRun[wouldRun.indexOf("--batch-id") + 1] === started.run_id && deepEqual(wouldRun.slice(-2), ["--action", "preview"]) && wouldRun.includes(DEFAULT_ASYNC_TASK_ROOT),
    dispatch_overrides_persist_in_run_state: deepEqual(state.dispatch_overrides, dispatchOverrideFixture),
    dispatch_overrides_forward_to_dispatch_prepare: [
      "--async-context-mode",
      "isolated"
    ].every((item) => wouldRun.includes(item)),
    tick_event_uses_compact_submission: compactOutcomeSample.task_id === "sample-task" && compactOutcomeSample.expected_report_path === "notes/explorer/sample.md" && !Object.hasOwn(compactOutcomeSample, "dispatch"),
    fleet_wait_detects_any_completion_notice: waitedNotice.event === "completion_notice" && waitedNotice.notice_count === 1 && waitedNotice.notices[0].task_id === "task-self-test-a" && waitedNotice.status_checked === false,
    fleet_wait_timeout_does_not_check_status: waitedTimeout.event === "timeout" && waitedTimeout.notice_count === 0 && waitedTimeout.status_checked === false,
    one_node_ready: ticked.submitted.length === 1,
    dependency_skipped: ticked.skipped.some((item) => item.node_id === "scan-b"),
    completion_inbox_updates_review_gate: refreshSummary.inbox === 1 && scanA.state === "needs_parent_review" && (scanA.last_status ?? {}).source === "completion_notice",
    review_pending_holds_dependency_without_blocking: deepEqual(tickWhileReviewPending.submitted, []) && reviewPendingScanB.state === "pending" && (reviewPendingScanB.blocked_by ?? null) === null,
    review_accept_unblocks_dependencies: acceptedReview.node_state === "done" && acceptedScanA.review_required === false && tickAfterReview.submitted.some((item) => item.node_id === "scan-b"),
    status_summary_reports_review_gate: summaryBeforeReview.summary.counts.needs_parent_review === 1 && summaryBeforeReview.summary.needs_review[0].id === "scan-a" && summaryBeforeReview.summary.needs_review[0].requires_parent_review === true,
    status_summary_reports_next_ready: summaryAfterReview.summary.next_ready.some((item) => item.id === "scan-b")
  };
}
function stBatchGetTelemetry(root) {
  const listRunId = "fleet-scheduler-list-self-test";
  const listTaskRoot = path17.join(runDir(root, listRunId), "async_tasks");
  const listTaskDir = path17.join(listTaskRoot, "task-self-test-list");
  mkdirSync9(listTaskDir, { recursive: true });
  writeJson2(path17.join(listTaskDir, "task.json"), {
    task_id: "task-self-test-list",
    task_root: listTaskRoot,
    task_dir: listTaskDir,
    target_cwd: ROOT
  });
  writeJson2(path17.join(listTaskDir, "status.json"), {
    task_id: "task-self-test-list",
    state: "running",
    created_at: utcNow(),
    updated_at: utcNow(),
    requires_parent_review: false
  });
  writeJson2(path17.join(listTaskDir, "child-task-live.json"), {
    rev: 5,
    status: "running",
    phase: "tool_call",
    updated_at: utcNow(),
    last_event_at: utcNow(),
    last_tool_call: { type: "shell_command", name: "self-test-shell", status: "running" },
    tool_call_counts: [{ key: "self-test-shell", count: 4 }]
  });
  const listState = {
    state_root: root,
    run_id: listRunId,
    nodes: [
      {
        id: "list-node",
        state: "running",
        task_id: "task-self-test-list",
        task_root: listTaskRoot,
        updated_at: utcNow()
      },
      {
        id: "deferred-node",
        state: "running",
        task_id: "task-self-test-deferred",
        task_root: listTaskRoot,
        next_liveness_check_at: utcAfter(300),
        updated_at: utcNow()
      }
    ]
  };
  const listRefreshSummary = refreshActiveNodes(listState);
  const listNode = listState.nodes[0];
  const deferredNode = listState.nodes[1];
  return {
    async_get_is_scoped_to_run_task_ids: listRefreshSummary.queried === 1 && listRefreshSummary.reconciled === 0 && (listNode.last_status ?? {}).source === "async_get"
  };
}
function stCriticality(root) {
  const criticalManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-scheduler-criticality-self-test",
    budget: { max_running_total: 1, max_submitted_per_tick: 1 },
    nodes: [
      { id: "root-shallow", seed: selfTestScanSeed("self-test shallow", ["ops/tools"]) },
      { id: "root-deep", seed: selfTestScanSeed("self-test deep", ["ops/policies"]) },
      {
        id: "middle",
        depends_on: ["root-deep"],
        seed: selfTestScanSeed("self-test middle", ["ops/protocols"])
      },
      {
        id: "leaf",
        depends_on: ["middle"],
        seed: selfTestScanSeed("self-test leaf", ["ops/workflows"])
      }
    ]
  };
  const criticalManifestFile = path17.join(root, "critical-manifest.json");
  writeJson2(criticalManifestFile, criticalManifest);
  const criticalStarted = startRun(criticalManifestFile, "", root, false);
  const criticalTicked = tickRun(criticalStarted.run_id, root, true);
  return { criticality_orders_ready_nodes: criticalTicked.submitted[0].node_id === "root-deep" };
}
function stReviewBlock(root, manifestFile, reviewEvidence) {
  const blockStarted = startRun(manifestFile, "fleet-review-block-self-test", root, false);
  const blockState = loadJson(statePath(root, blockStarted.run_id));
  const blockScanA = indexNodes(blockState)["scan-a"];
  blockScanA.state = "needs_parent_review";
  blockScanA.task_id = "task-review-block";
  writeJson2(statePath(root, blockStarted.run_id), blockState);
  const blockedReview = reviewRun(
    blockStarted.run_id,
    root,
    "scan-a",
    "blocked",
    reviewEvidence,
    "self-test block"
  );
  tickRun(blockStarted.run_id, root, false);
  const stateAfterBlock = loadJson(statePath(root, blockStarted.run_id));
  const blockedScanA = indexNodes(stateAfterBlock)["scan-a"];
  const blockedScanB = indexNodes(stateAfterBlock)["scan-b"];
  return {
    review_block_blocks_dependencies: blockedReview.node_state === "blocked" && blockedScanA.review_required === false && blockedScanB.state === "blocked" && blockedScanB.blocked_by === "scan-a"
  };
}
function stReviewRequeue(root, manifestFile, reviewEvidence) {
  const requeueStarted = startRun(manifestFile, "fleet-review-requeue-self-test", root, false);
  const requeueState = loadJson(statePath(root, requeueStarted.run_id));
  const requeueScanA = indexNodes(requeueState)["scan-a"];
  requeueScanA.state = "needs_parent_review";
  requeueScanA.task_id = "task-review-requeue";
  requeueScanA.dispatch = { task_id: "task-review-requeue" };
  requeueScanA.last_status = { state: "done", requires_parent_review: true };
  writeJson2(statePath(root, requeueStarted.run_id), requeueState);
  const requeuedReview = reviewRun(
    requeueStarted.run_id,
    root,
    "scan-a",
    "requeued",
    reviewEvidence,
    "self-test requeue"
  );
  const requeuedState = loadJson(statePath(root, requeueStarted.run_id));
  const requeuedScanA = indexNodes(requeuedState)["scan-a"];
  const requeueResetVerified = requeuedReview.node_state === "pending" && requeuedScanA.task_id === null && requeuedScanA.dispatch === null && requeuedScanA.last_status === null && requeuedScanA.review_required === false && requeuedScanA.review_decision === null && Array.isArray(requeuedScanA.review_history) && requeuedScanA.review_history[requeuedScanA.review_history.length - 1].decision === "requeued" && requeuedScanA.superseded_task_ids[requeuedScanA.superseded_task_ids.length - 1] === "task-review-requeue";
  const requeueTaskRoot = path17.join(runDir(root, requeueStarted.run_id), "async_tasks");
  requeuedScanA.task_root = requeueTaskRoot;
  const requeueInbox = asyncCompletionInbox(requeueTaskRoot);
  mkdirSync9(requeueInbox, { recursive: true });
  requeuedScanA.state = "running";
  requeuedScanA.task_id = "task-review-requeue-fresh";
  requeuedScanA.receipt_task_id = "task-review-requeue-fresh";
  writeJson2(path17.join(requeueInbox, "task-review-requeue.json"), {
    task_id: "task-review-requeue",
    state: "done"
  });
  const staleReceiptRefresh = refreshActiveNodes(requeuedState);
  const staleReceiptIgnored = staleReceiptRefresh.inbox === 0 && requeuedScanA.state === "running" && (requeuedScanA.last_status ?? null) === null;
  writeJson2(path17.join(requeueInbox, "task-review-requeue-fresh.json"), {
    task_id: "task-review-requeue-fresh",
    state: "done"
  });
  const freshReceiptRefresh = refreshActiveNodes(requeuedState);
  const unboundNode = { id: "unbound", state: "running", task_id: null };
  const unboundReceiptApplied = applyAsyncStatus(
    unboundNode,
    { task_id: "task-review-requeue", state: "done" },
    "self_test"
  );
  return {
    review_requeue_resets_node: requeueResetVerified,
    stale_requeue_receipt_does_not_update_fresh_attempt: staleReceiptIgnored,
    fresh_requeue_receipt_updates_current_attempt: freshReceiptRefresh.inbox === 1 && requeuedScanA.receipt_task_id === "task-review-requeue-fresh",
    receipt_without_current_task_id_is_rejected: unboundReceiptApplied === false && unboundNode.state === "running" && (unboundNode.last_status ?? null) === null
  };
}
function stCompletedRequeue(root, manifestFile, reviewEvidence) {
  const completedRequeueStarted = startRun(
    manifestFile,
    "fleet-completed-requeue-self-test",
    root,
    false
  );
  const completedRequeueState = loadJson(statePath(root, completedRequeueStarted.run_id));
  const completedRequeueScanA = indexNodes(completedRequeueState)["scan-a"];
  completedRequeueScanA.state = "done";
  completedRequeueScanA.task_id = "task-completed-stale-evidence";
  writeJson2(statePath(root, completedRequeueStarted.run_id), completedRequeueState);
  const completedRequeueReview = reviewRun(
    completedRequeueStarted.run_id,
    root,
    "scan-a",
    "requeued",
    reviewEvidence,
    "self-test stale completed evidence"
  );
  const completedRequeueResult = indexNodes(
    loadJson(statePath(root, completedRequeueStarted.run_id))
  )["scan-a"];
  return {
    completed_node_can_requeue_stale_evidence: completedRequeueReview.node_state === "pending" && completedRequeueResult.task_id === null && completedRequeueResult.review_history[completedRequeueResult.review_history.length - 1].previous_state === "done"
  };
}
function stTerminalClassification() {
  const failedTerminalNode = { id: "failed-terminal", state: "running" };
  applyAsyncStatus(
    failedTerminalNode,
    { state: "failed", failure_type: "worker_process_exit", requires_parent_review: true },
    "self_test"
  );
  const userCancelledNode = { id: "user-cancelled", state: "running" };
  applyAsyncStatus(
    userCancelledNode,
    { state: "cancelled", cancel_reason: "user_requested", requires_parent_review: false },
    "self_test"
  );
  const nonUserCancelledNode = { id: "non-user-cancelled", state: "running" };
  applyAsyncStatus(
    nonUserCancelledNode,
    { state: "cancelled", cancel_reason: "worker_shutdown", requires_parent_review: false },
    "self_test"
  );
  return {
    failed_terminal_settles_without_review: failedTerminalNode.state === "failed" && failedTerminalNode.review_required === false,
    explicit_user_cancel_stays_cancelled: userCancelledNode.state === "cancelled" && userCancelledNode.review_required === false,
    non_user_cancel_settles_failure: nonUserCancelledNode.state === "failed" && nonUserCancelledNode.review_required === false
  };
}
function stBlockRecovery() {
  const historicalBlockState = {
    nodes: [
      { id: "upstream", state: "done", depends_on: [] },
      { id: "downstream", state: "blocked", blocked_by: "upstream", depends_on: ["upstream"] }
    ]
  };
  const historicalById = indexNodes(historicalBlockState);
  const releasedHistoricalBlocks = releaseResolvedDependencyBlocks(historicalBlockState, historicalById);
  const recoveredDownstream = historicalById.downstream;
  const dispatchFailureNode = { id: "dispatch-failure", state: "pending" };
  markFailure(dispatchFailureNode, {
    contractState: "dispatch_prepare_failed",
    failureType: "dispatch_prepare_exit",
    error: "dispatch_prepare exited 1 without output"
  });
  const legacyDispatchState = {
    nodes: [
      {
        id: "legacy-dispatch-failure",
        state: "blocked",
        task_id: null,
        dispatch: { error: "", stdout: "" }
      }
    ]
  };
  const promotedLegacyDispatchFailures = promoteLegacyDispatchFailureBlocks(legacyDispatchState);
  const promotedLegacyDispatchNode = legacyDispatchState.nodes[0];
  return {
    resolved_dependency_block_recovers_to_pending: deepEqual(releasedHistoricalBlocks, ["downstream"]) && recoveredDownstream.state === "pending" && (recoveredDownstream.blocked_by ?? null) === null,
    dispatch_failure_settles_without_review: dispatchFailureNode.state === "failed" && dispatchFailureNode.review_required === false && dispatchFailureNode.last_status.contract_state === "dispatch_prepare_failed"
  };
}
function stDriverOutcomes() {
  const completedDriverState = { nodes: [{ id: "done", state: "done" }] };
  const reviewDriverState = {
    nodes: [
      { id: "review", state: "needs_parent_review" },
      { id: "downstream", state: "pending", depends_on: ["review"] }
    ]
  };
  const blockedDriverState = { nodes: [{ id: "blocked", state: "blocked" }] };
  const runningDriverState = { nodes: [{ id: "running", state: "running" }] };
  return {
    autodrive_outcome_is_mechanical: driverOutcome(completedDriverState) === "completed" && driverOutcome(reviewDriverState) === "needs_parent_review" && driverOutcome(blockedDriverState) === "blocked" && driverOutcome(runningDriverState) === "running"
  };
}
function stDependencyArtifacts(root, manifest) {
  const dependencyReport = path17.join(root, "dependency-report.md");
  writeFileSync7(dependencyReport, "# dependency report\n", "utf8");
  const artifactState = {
    nodes: [
      { id: "upstream", state: "done", last_status: { report_path: dependencyReport } },
      { id: "reducer", state: "pending", depends_on: ["upstream"] }
    ]
  };
  const artifactManifestNode = {
    id: "reducer",
    depends_on: ["upstream"],
    dependency_artifacts: ["report"],
    seed: deepCopy2(manifest.nodes[1].seed)
  };
  const injectedArtifactSeed = seedWithDependencyArtifacts(
    artifactState,
    indexNodes(artifactState).reducer,
    artifactManifestNode
  );
  const missingArtifactState = {
    state_root: root,
    run_id: "missing-artifact",
    nodes: [
      { id: "upstream", state: "done", last_status: {} },
      { id: "reducer", state: "pending", depends_on: ["upstream"] }
    ]
  };
  const missingArtifactNode = indexNodes(missingArtifactState).reducer;
  const missingArtifactOutcome = dispatchNode(
    missingArtifactState,
    manifest,
    missingArtifactNode,
    artifactManifestNode,
    { dryRun: false }
  );
  return {
    dependency_artifacts_injected_into_downstream_seed: ((injectedArtifactSeed.scope ?? {}).read ?? []).includes(resolveLikePython(dependencyReport)),
    missing_dependency_artifact_settles_failure: missingArtifactOutcome.status === "failed" && missingArtifactNode.state === "failed" && missingArtifactNode.review_required === false && missingArtifactNode.last_status.contract_state === "dependency_artifact_missing"
  };
}
function stAllSettled(root, manifest) {
  const settledReport = path17.join(root, "settled-partial-report.md");
  writeFileSync7(settledReport, "# partial but consumable\n", "utf8");
  const settledState = {
    state_root: root,
    run_id: "all-settled-partial",
    nodes: [
      {
        id: "upstream",
        state: "needs_parent_review",
        review_required: true,
        review_decision: "pending",
        last_status: {
          state: "done",
          business_state: "partial",
          requires_parent_review: true,
          report_path: settledReport
        }
      },
      {
        id: "reducer",
        state: "pending",
        depends_on: ["upstream"],
        dependency_policy: "all_settled"
      }
    ]
  };
  const settledUpdates = registerAllSettledConsumers(settledState);
  const settledById = indexNodes(settledState);
  const settledUpstream = settledById.upstream;
  const settledReducer = settledById.reducer;
  const settledManifestNode = {
    id: "reducer",
    depends_on: ["upstream"],
    dependency_artifacts: ["report"],
    dependency_policy: "all_settled",
    seed: deepCopy2(manifest.nodes[1].seed)
  };
  const settledSeed = seedWithDependencyArtifacts(settledState, settledReducer, settledManifestNode);
  const settledIndexPath = dependencyResultIndexPath(root, "all-settled-partial", "reducer");
  const settledIndex = loadJson(settledIndexPath);
  const failedSettledState = {
    state_root: root,
    run_id: "all-settled-failed",
    nodes: [
      {
        id: "upstream",
        state: "needs_parent_review",
        review_required: true,
        review_decision: "pending",
        last_status: {
          state: "failed",
          business_state: "failed",
          requires_parent_review: true,
          contract_state: "worker_failed",
          failure_type: "worker_process_exit"
        }
      },
      {
        id: "reducer",
        state: "pending",
        depends_on: ["upstream"],
        dependency_policy: "all_settled"
      }
    ]
  };
  registerAllSettledConsumers(failedSettledState);
  const failedSettledById = indexNodes(failedSettledState);
  const failedSettledReducer = failedSettledById.reducer;
  const failedSettledSeed = seedWithDependencyArtifacts(
    failedSettledState,
    failedSettledReducer,
    settledManifestNode
  );
  const failedSettledIndex = loadJson(
    dependencyResultIndexPath(root, "all-settled-failed", "reducer")
  );
  const completedSettledDriverState = deepCopy2(failedSettledState);
  completedSettledDriverState.nodes[1].state = "done";
  const settledReads = (settledSeed.scope ?? {}).read ?? [];
  return {
    all_settled_defers_leaf_review_to_reducer: deepEqual(settledUpdates, ["upstream"]) && settledUpstream.state === "done" && settledUpstream.review_required === false && deepEqual(settledUpstream.review_deferred_to, ["reducer"]),
    all_settled_reducer_accepts_partial_dependency: dependenciesReady(settledReducer, settledById) && blockedByFailedDependency(settledReducer, settledById) === null,
    all_settled_injects_report_and_result_index: settledReads.includes(resolveLikePython(settledReport)) && settledReads.includes(resolveLikePython(settledIndexPath)) && settledReads[0] === resolveLikePython(settledIndexPath) && settledIndex.dependencies[0].business_state === "partial" && settledIndex.dependencies[0].artifact_state === "available",
    all_settled_missing_artifact_is_reducer_input: dependenciesReady(failedSettledReducer, failedSettledById) && blockedByFailedDependency(failedSettledReducer, failedSettledById) === null && failedSettledIndex.dependencies[0].execution_state === "failed" && failedSettledIndex.dependencies[0].artifact_state === "missing" && ((failedSettledSeed.scope ?? {}).read ?? []).includes(
      resolveLikePython(dependencyResultIndexPath(root, "all-settled-failed", "reducer"))
    ),
    all_settled_reducer_completion_closes_run: driverOutcome(completedSettledDriverState) === "completed"
  };
}
function stStateRootGuard() {
  let rejected;
  try {
    stateRoot(path17.dirname(ROOT));
    rejected = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    rejected = true;
  }
  return { external_state_root_rejected: rejected };
}
function stAcceptanceGate() {
  const gateRoot = mkdtempSync(path17.join(selfTestRoot(), "fleet-acceptance-gate-"));
  try {
    const gateManifestById = {
      "verify-a": {
        id: "verify-a",
        seed: {
          route_id: "verify-agent__code-verification",
          slug: "gate-leaf",
          contract: {
            acceptance_context: {
              acceptance_ids: ["AC-01", "AC-02"],
              items: [{ acceptance_id: "AC-01" }, { acceptance_id: "AC-02" }]
            }
          }
        }
      },
      reduce: {
        id: "reduce",
        reducer: true,
        is_reducer: true,
        seed: { route_id: "verify-agent__acceptance-synthesis" }
      }
    };
    const gateState = () => ({
      nodes: [
        { id: "verify-a", state: "done", task_id: "task-gate-1", review_history: [] },
        { id: "reduce", state: "pending", task_id: null }
      ],
      events: [],
      event_revision: 0,
      revision: 0
    });
    const missingState = gateState();
    const missingActions = enforceAcceptanceResultsGate(missingState, gateManifestById, { reportRoot: gateRoot });
    const missNode = indexNodes(missingState)["verify-a"];
    const gateAnnotatesWithoutRequeue = missingActions.length === 1 && missingActions[0].action === "derive_from_prose" && missNode.state === "done" && missNode.task_id === "task-gate-1" && Boolean(missNode.acceptance_results_block) && missNode.acceptance_results_checked === "task-gate-1";
    const gateChecksOncePerTask = deepEqual(
      enforceAcceptanceResultsGate(missingState, gateManifestById, { reportRoot: gateRoot }),
      []
    );
    const [, gateIndexEntries] = dependencyResultEntries(
      missingState,
      { id: "reduce", state: "pending", task_id: null, depends_on: ["verify-a"] },
      { id: "reduce", dependency_policy: "all_settled" }
    );
    const gateAnnotationReachesReducerIndex = gateIndexEntries.some(
      (entry) => entry.node_id === "verify-a" && entry.acceptance_results_block
    );
    const block = JSON.stringify(
      {
        acceptance_results: [
          { acceptance_id: "AC-01", gate: "pass", evidence_refs: [] },
          { acceptance_id: "AC-02", gate: "fail", evidence_refs: [] }
        ]
      },
      null,
      2
    );
    writeFileSync7(
      path17.join(gateRoot, "gate-leaf.md"),
      `# report

\`\`\`json acceptance_results
${block}
\`\`\`
`,
      "utf8"
    );
    const okState = gateState();
    const okActions = enforceAcceptanceResultsGate(okState, gateManifestById, { reportRoot: gateRoot });
    const gatePassesValidBlock = deepEqual(okActions, []) && indexNodes(okState)["verify-a"].state === "done" && indexNodes(okState)["verify-a"].acceptance_results_checked === "task-gate-1" && !Object.hasOwn(indexNodes(okState)["verify-a"], "acceptance_results_block");
    return {
      acceptance_gate_annotates_without_requeue: gateAnnotatesWithoutRequeue,
      acceptance_gate_checks_once_per_task: gateChecksOncePerTask,
      acceptance_gate_annotation_reaches_reducer_index: gateAnnotationReachesReducerIndex,
      acceptance_gate_passes_valid_block: gatePassesValidBlock
    };
  } finally {
    rmSync5(gateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
function stCompaction() {
  const compacted = compactNode({
    id: "salvage-probe",
    state: "done",
    last_status: {
      salvage_report_path: null,
      salvage_evidence_paths: ["/tmp/task/child-final.md"]
    }
  });
  return {
    salvage_evidence_paths_survives_compaction: deepEqual(compacted.salvage_evidence_paths, ["/tmp/task/child-final.md"])
  };
}
function stCommandNodes(root) {
  const marker = path17.join(root, "command-marker.txt");
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-command-self-test",
    nodes: [
      {
        id: "produce",
        kind: "command",
        command: {
          argv: [
            NODE,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'made', 'utf8'); console.log('produced');`
          ],
          timeout_seconds: 120
        }
      },
      {
        id: "consume",
        kind: "command",
        depends_on: ["produce"],
        command: {
          argv: [
            NODE,
            "-e",
            `process.exit(require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8') === 'made' ? 0 : 7);`
          ],
          timeout_seconds: 120
        }
      }
    ]
  };
  const manifestFile = path17.join(root, "command-manifest.json");
  writeJson2(manifestFile, manifest);
  const dryStarted = startRun(manifestFile, "fleet-command-dry-self-test", root, false);
  const dryTick = tickRun(dryStarted.run_id, root, true, true);
  const dryDispatch = dryTick.submitted[0].dispatch ?? {};
  const started = startRun(manifestFile, "", root, false);
  const first = tickRun(started.run_id, root, false);
  const stateAfterFirst = loadJson(statePath(root, started.run_id));
  const produceNode = indexNodes(stateAfterFirst).produce;
  const second = tickRun(started.run_id, root, false);
  const stateAfterSecond = loadJson(statePath(root, started.run_id));
  const consumeNode = indexNodes(stateAfterSecond).consume;
  const stdoutLog = (produceNode.command_result ?? {}).stdout_path ?? "";
  const failManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-command-fail-self-test",
    nodes: [
      {
        id: "boom",
        kind: "command",
        command: { argv: [NODE, "-e", "process.exit(3);"], timeout_seconds: 60 }
      }
    ]
  };
  const failFile = path17.join(root, "command-fail-manifest.json");
  writeJson2(failFile, failManifest);
  const failStarted = startRun(failFile, "", root, false);
  tickRun(failStarted.run_id, root, false);
  const boom = indexNodes(loadJson(statePath(root, failStarted.run_id))).boom;
  const dependencyReport = path17.join(root, "command-dependency-report.md");
  writeFileSync7(dependencyReport, "# upstream report\n", "utf8");
  const indexState = {
    state_root: root,
    run_id: "command-index-self-test",
    nodes: [
      { id: "upstream", state: "done", last_status: { report_path: dependencyReport } },
      { id: "check-index", state: "pending", depends_on: ["upstream"] }
    ]
  };
  const indexManifestNode = {
    id: "check-index",
    kind: "command",
    depends_on: ["upstream"],
    dependency_artifacts: ["report"],
    dependency_policy: "all_settled",
    command: {
      argv: [
        NODE,
        "-e",
        "const index = JSON.parse(require('node:fs').readFileSync(process.env.FLEET_DEPENDENCY_RESULT_INDEX, 'utf8')); process.exit(index.dependencies[0].artifact_state === 'available' ? 0 : 9);"
      ],
      timeout_seconds: 120
    }
  };
  const indexNode = indexNodes(indexState)["check-index"];
  const indexOutcome = dispatchNode(indexState, manifest, indexNode, indexManifestNode, { dryRun: false });
  return {
    command_node_executes_and_completes: first.status === "ok" && produceNode.state === "done" && (produceNode.last_status ?? {}).source === "fleet_command" && existsSync10(marker),
    command_completion_releases_downstream: second.submitted.some((item) => item.node_id === "consume") && consumeNode.state === "done" && stateAfterSecond.run_state === "completed",
    command_dry_run_reports_argv: dryTick.dry_run === true && Boolean(dryDispatch.would_run) && dryDispatch.would_run[0] === NODE,
    command_stdout_persisted: Boolean(stdoutLog) && existsSync10(stdoutLog),
    command_failure_settles_without_review: boom.state === "failed" && (boom.last_status ?? {}).contract_state === "command_failed" && boom.review_required === false,
    command_receives_dependency_result_index: indexOutcome.status === "ok" && indexNode.state === "done"
  };
}
function stGateNodes(root) {
  const gateManifest = (runId) => ({
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    nodes: [
      {
        id: "before",
        kind: "command",
        command: { argv: [NODE, "-e", "console.log('before gate');"], timeout_seconds: 60 }
      },
      { id: "confirm", kind: "gate", depends_on: ["before"] },
      {
        id: "after",
        kind: "command",
        depends_on: ["confirm"],
        command: { argv: [NODE, "-e", "console.log('after gate');"], timeout_seconds: 60 }
      }
    ]
  });
  const evidence = path17.join(root, "gate-review-evidence.md");
  writeFileSync7(evidence, "# gate decision evidence\n", "utf8");
  const acceptFile = path17.join(root, "gate-accept-manifest.json");
  writeJson2(acceptFile, gateManifest("fleet-gate-accept-self-test"));
  const started = startRun(acceptFile, "", root, false);
  tickRun(started.run_id, root, false);
  tickRun(started.run_id, root, false);
  const openedState = loadJson(statePath(root, started.run_id));
  const confirm = indexNodes(openedState).confirm;
  const afterHold = indexNodes(openedState).after;
  const outcomeWhileOpen = driverOutcome(openedState);
  const accepted = reviewRun(started.run_id, root, "confirm", "accepted", evidence, "gate accept");
  tickRun(started.run_id, root, false);
  const finalState = loadJson(statePath(root, started.run_id));
  const blockFile = path17.join(root, "gate-block-manifest.json");
  writeJson2(blockFile, gateManifest("fleet-gate-block-self-test"));
  const blockStarted = startRun(blockFile, "", root, false);
  tickRun(blockStarted.run_id, root, false);
  tickRun(blockStarted.run_id, root, false);
  reviewRun(blockStarted.run_id, root, "confirm", "blocked", evidence, "gate block");
  tickRun(blockStarted.run_id, root, false);
  const blockedState = loadJson(statePath(root, blockStarted.run_id));
  const blockedAfter = indexNodes(blockedState).after;
  return {
    gate_opens_after_dependency_done: confirm.state === "needs_parent_review" && confirm.review_decision === "pending" && (confirm.last_status ?? {}).source === "fleet_gate",
    gate_holds_downstream_until_decision: afterHold.state === "pending" && outcomeWhileOpen === "needs_parent_review",
    gate_accept_releases_downstream: accepted.node_state === "done" && indexNodes(finalState).after.state === "done" && finalState.run_state === "completed",
    gate_block_blocks_downstream: blockedAfter.state === "blocked" && blockedAfter.blocked_by === "confirm" && blockedState.failure_fuse.status === "tripped"
  };
}
function stGateAllSettled(root) {
  const bypassManifest = (runId) => ({
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    nodes: [
      {
        id: "before",
        kind: "command",
        command: { argv: [NODE, "-e", "console.log('upstream artifact body');"], timeout_seconds: 60 }
      },
      { id: "confirm", kind: "gate", depends_on: ["before"] },
      {
        id: "after",
        kind: "command",
        depends_on: ["before", "confirm"],
        dependency_artifacts: ["report"],
        dependency_policy: "all_settled",
        command: { argv: [NODE, "-e", "console.log('after gate');"], timeout_seconds: 60 }
      }
    ]
  });
  const evidence = path17.join(root, "gate-all-settled-evidence.md");
  writeFileSync7(evidence, "# gate all_settled evidence\n", "utf8");
  const acceptFile = path17.join(root, "gate-all-settled-manifest.json");
  writeJson2(acceptFile, bypassManifest("fleet-gate-all-settled-self-test"));
  const started = startRun(acceptFile, "", root, false);
  tickRun(started.run_id, root, false);
  tickRun(started.run_id, root, false);
  tickRun(started.run_id, root, false);
  const openedState = loadJson(statePath(root, started.run_id));
  const confirm = indexNodes(openedState).confirm;
  const afterHold = indexNodes(openedState).after;
  const held = confirm.state === "needs_parent_review" && afterHold.state === "pending" && driverOutcome(openedState) === "needs_parent_review" && !(confirm.all_settled_consumers ?? []).length && confirm.review_required === true;
  reviewRun(started.run_id, root, "confirm", "accepted", evidence, "gate all_settled accept");
  tickRun(started.run_id, root, false);
  const finalState = loadJson(statePath(root, started.run_id));
  const afterFinal = indexNodes(finalState).after;
  const indexFile = dependencyResultIndexPath(root, loadJson(statePath(root, started.run_id)).run_id, "after");
  const indexData = existsSync10(indexFile) ? loadJson(indexFile) : { dependencies: [] };
  const entries = {};
  for (const entry of indexData.dependencies ?? []) entries[entry.node_id] = entry;
  const beforeEntry = entries.before ?? {};
  const confirmEntry = entries.confirm ?? {};
  const blockFile = path17.join(root, "gate-all-settled-block-manifest.json");
  writeJson2(blockFile, bypassManifest("fleet-gate-all-settled-block-self-test"));
  const blockStarted = startRun(blockFile, "", root, false);
  tickRun(blockStarted.run_id, root, false);
  tickRun(blockStarted.run_id, root, false);
  reviewRun(blockStarted.run_id, root, "confirm", "blocked", evidence, "gate all_settled block");
  tickRun(blockStarted.run_id, root, false);
  const blockedState = loadJson(statePath(root, blockStarted.run_id));
  const blockedAfter = indexNodes(blockedState).after;
  return {
    gate_not_bypassed_by_all_settled_consumer: held,
    gate_accept_releases_all_settled_consumer: afterFinal.state === "done" && finalState.run_state === "completed",
    gate_dependency_skips_artifact_requirement: confirmEntry.artifact_state === "not_requested",
    command_stdout_serves_as_report_artifact: beforeEntry.artifact_state === "available" && Boolean((beforeEntry.artifacts ?? {}).report),
    gate_block_blocks_all_settled_consumer: blockedAfter.state === "blocked" && blockedAfter.blocked_by === "confirm"
  };
}
function stDriverChain(root) {
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-driver-chain-self-test",
    nodes: [
      {
        id: "one",
        kind: "command",
        command: { argv: [NODE, "-e", "console.log('one');"], timeout_seconds: 60 }
      },
      {
        id: "two",
        kind: "command",
        depends_on: ["one"],
        command: { argv: [NODE, "-e", "console.log('two');"], timeout_seconds: 60 }
      }
    ]
  };
  const manifestFile = path17.join(root, "driver-chain-manifest.json");
  writeJson2(manifestFile, manifest);
  const started = startRun(manifestFile, "", root, false);
  const outcome = driveRun(started.run_id, root, 1e3);
  const state = loadJson(statePath(root, started.run_id));
  return {
    driver_drains_synchronous_chain: outcome.status === "completed" && outcome.ticks >= 2 && indexNodes(state).two.state === "done"
  };
}
function selfTestRoot() {
  const testRoot = path17.join(ROOT, ".runtime", "self-tests", "migration-lock");
  mkdirSync9(testRoot, { recursive: true });
  return testRoot;
}
function selfTest() {
  const manifest = selfTestTwoNodeManifest();
  const testRoot = selfTestRoot();
  const root = mkdtempSync(path17.join(testRoot, "fleet-self-test-"));
  try {
    const manifestFile = path17.join(root, "manifest.json");
    writeJson2(manifestFile, manifest);
    const reviewEvidence = path17.join(root, "review-evidence.md");
    writeFileSync7(reviewEvidence, "self-test review evidence\n", "utf8");
    const scenarios = [
      () => stMutationLock(root),
      () => stPrimaryRun(root, manifestFile, reviewEvidence),
      () => stBatchGetTelemetry(root),
      () => stCriticality(root),
      () => stReviewBlock(root, manifestFile, reviewEvidence),
      () => stReviewRequeue(root, manifestFile, reviewEvidence),
      () => stCompletedRequeue(root, manifestFile, reviewEvidence),
      () => stTerminalClassification(),
      () => stBlockRecovery(),
      () => stDriverOutcomes(),
      () => stDependencyArtifacts(root, manifest),
      () => stAllSettled(root, manifest),
      () => stStateRootGuard(),
      () => stAcceptanceGate(),
      () => stCompaction(),
      () => stCommandNodes(root),
      () => stGateNodes(root),
      () => stGateAllSettled(root),
      () => stDriverChain(root)
    ];
    const checks = {};
    for (const scenario of scenarios) {
      for (const [name, passed] of Object.entries(scenario())) {
        if (Object.hasOwn(checks, name)) throw new ToolError(`duplicate self-test check name: ${name}`);
        checks[name] = Boolean(passed);
      }
    }
    return {
      status: Object.values(checks).every(Boolean) ? "ok" : "failed",
      checks,
      verification: {
        batch_get_uses_only_run_task_ids: checks.async_get_is_scoped_to_run_task_ids,
        completion_wait_does_not_poll_status: checks.fleet_wait_timeout_does_not_check_status,
        failed_terminal_requires_parent_decision: checks.failed_terminal_requires_parent_decision,
        review_gate_semantics_preserved: checks.review_accept_unblocks_dependencies && checks.review_block_blocks_dependencies && checks.review_requeue_resets_node,
        all_settled_reducer_semantics: checks.all_settled_defers_leaf_review_to_reducer && checks.all_settled_reducer_accepts_partial_dependency && checks.all_settled_missing_artifact_is_reducer_input && checks.all_settled_reducer_completion_closes_run
      }
    };
  } finally {
    rmSync5(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
var NODE;
var init_fleet_scheduler_selftest = __esm({
  async "ops/tools/fleet_scheduler.selftest.mjs"() {
    await init_fleet_scheduler();
    init_tool_common();
    await init_fleet_manifest_check();
    NODE = process9.execPath;
  }
});

// ops/tools/fleet_scheduler.mjs
init_tool_common();
init_py();
await init_fleet_scheduler();
await init_fleet_scheduler_selftest();
import process10 from "node:process";

// ops/tools/dispatch-core/fleet-command-worker.mjs
import { spawn as spawn4 } from "node:child_process";
import { existsSync as existsSync11, readFileSync as readFileSync11, writeFileSync as writeFileSync8 } from "node:fs";

// ops/tools/pi_child_bash_process_tree.mjs
import * as piChildBashProcess from "node:child_process";
function snapshotChildProcessTree(roots, options = {}) {
  const platform = options.platform || process.platform;
  const run2 = options.spawnSyncFn || piChildBashProcess.spawnSync;
  const result = platform === "win32" ? run2("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 5e3, windowsHide: true }) : run2("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5e3 });
  if (result.status !== 0 || result.error) return null;
  let entries;
  try {
    if (platform === "win32") {
      const data = JSON.parse(String(result.stdout));
      entries = (Array.isArray(data) ? data : [data]).map((item) => [Number(item.ProcessId), Number(item.ParentProcessId)]);
    } else {
      entries = String(result.stdout).trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
    }
  } catch {
    return null;
  }
  const selected = new Set(roots.map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of entries) {
      if (selected.has(parent) && !selected.has(pid)) {
        selected.add(pid);
        changed = true;
      }
    }
  }
  return entries.filter(([pid]) => selected.has(pid)).map(([pid]) => pid);
}
function terminateChildProcessTree(pid, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || piChildBashProcess.spawnSync;
  if (!pid) return { requested: false, reason: "missing_pid" };
  const tracked = snapshotChildProcessTree([pid], { platform, spawnSyncFn });
  const observed = Array.isArray(tracked) && tracked.includes(Number(pid));
  options.onCaptured?.({ pid, tracked_pids: tracked, observed, confirmed: false });
  const proof = (exitCode) => {
    const remaining = observed ? snapshotChildProcessTree(tracked, { platform, spawnSyncFn }) : null;
    return { tracked_pids: tracked, observed, remaining_pids: remaining, confirmed: exitCode === 0 && observed && remaining?.length === 0 };
  };
  if (platform === "win32") {
    const result = spawnSyncFn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 15e3,
      windowsHide: true
    });
    return {
      requested: true,
      exitCode: result.status ?? null,
      error: result.error?.message || null,
      ...proof(result.status)
    };
  }
  try {
    process.kill(-Number(pid), "SIGKILL");
    return { requested: true, exitCode: 0, error: null, ...proof(0) };
  } catch {
    try {
      process.kill(Number(pid), "SIGKILL");
      return { requested: true, exitCode: 0, error: null, ...proof(0) };
    } catch (error) {
      return { requested: false, reason: "kill_failed", error: error?.message || String(error), ...proof(null) };
    }
  }
}

// ops/tools/dispatch-core/fleet-command-worker.mjs
function spawnFleetCommand(argv, options) {
  const [command, ...args] = argv;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command))) {
    const quote = (value) => {
      const text3 = String(value);
      return /[\s"^&|<>()%!]/.test(text3) ? `"${text3.replace(/"/g, '\\"')}"` : text3;
    };
    return spawn4([command, ...args].map(quote).join(" "), [], { ...options, shell: true });
  }
  return spawn4(command, args, options);
}
async function runFleetCommand(specPath) {
  const spec = JSON.parse(readFileSync11(specPath, "utf8"));
  if (existsSync11(spec.cancel_path)) {
    writeFileSync8(spec.result_path, JSON.stringify({ cancelled: true, confirmed: true, not_executed: true }));
    return 0;
  }
  const child = spawnFleetCommand(spec.argv, {
    cwd: spec.cwd,
    env: process.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"]
  });
  let proof = null;
  let cancelled = false;
  let timedOut = false;
  const started = Date.now();
  const timer = setInterval(() => {
    cancelled ||= existsSync11(spec.cancel_path);
    timedOut ||= Date.now() - started >= spec.timeout_ms;
    if ((cancelled || timedOut) && child.exitCode === null && child.signalCode === null && child.pid) {
      proof = terminateChildProcessTree(child.pid);
    }
  }, 100);
  try {
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error: error.message, error_code: error.code }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    writeFileSync8(spec.result_path, JSON.stringify({ ...result, cancelled, timed_out: timedOut, confirmed: proof?.confirmed ?? !(cancelled || timedOut), proof }));
    return result.code ?? 1;
  } finally {
    clearInterval(timer);
  }
}

// ops/tools/fleet_scheduler.mjs
var PROGRAM = "fleet_scheduler.mjs";
var FORMAT = { dest: "format", default: "text", choices: ["text", "json"] };
var COMMANDS = {
  "command-worker": {
    values: { "--spec": { dest: "spec", required: true } },
    flags: {}
  },
  cancel: {
    values: {
      "--run-id": { dest: "run_id", required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--reason": { dest: "reason", required: true },
      "--format": FORMAT
    },
    flags: {}
  },
  start: {
    values: {
      "--manifest": { dest: "manifest", default: null, required: true },
      "--run-id": { dest: "run_id", default: "" },
      "--state-root": { dest: "state_root", default: "" },
      "--async-context-mode": { dest: "async_context_mode", default: "", choices: ["isolated", "project-aware"] },
      "--format": FORMAT
    },
    flags: { "--force": "force" }
  },
  pause: {
    values: {
      "--run-id": { dest: "run_id", required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--reason": { dest: "reason", required: true },
      "--format": FORMAT
    },
    flags: {}
  },
  tick: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--format": FORMAT
    },
    flags: { "--dry-run": "dry_run", "--verbose": "verbose" }
  },
  wait: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--wait-ms": { dest: "wait_ms", default: 6e4, type: "int" },
      "--format": FORMAT
    },
    flags: { "--verbose": "verbose" }
  },
  resume: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--format": FORMAT
    },
    flags: { "--dry-run": "dry_run", "--verbose": "verbose" }
  },
  run: {
    values: {
      "--manifest": { dest: "manifest", default: "" },
      "--run-id": { dest: "run_id", default: "" },
      "--state-root": { dest: "state_root", default: "" },
      "--wait-ms": { dest: "wait_ms", default: 6e4, type: "int" },
      "--async-context-mode": { dest: "async_context_mode", default: "", choices: ["isolated", "project-aware"] },
      "--format": FORMAT
    },
    flags: { "--force": "force" }
  },
  drive: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--wait-ms": { dest: "wait_ms", default: 6e4, type: "int" },
      "--format": FORMAT
    },
    flags: {}
  },
  status: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--format": FORMAT
    },
    flags: { "--summary": "summary" }
  },
  review: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--node-id": { dest: "node_id", default: null, required: true },
      "--evidence": { dest: "evidence", default: null },
      "--reason": { dest: "reason", default: "" },
      "--format": FORMAT
    },
    flags: { "--accept": "accept", "--block": "block", "--requeue": "requeue" },
    decisionGroup: ["--accept", "--block", "--requeue"]
  },
  "self-test": {
    values: { "--format": FORMAT },
    flags: {}
  }
};
var USAGE = `usage: ${PROGRAM} [-h] {start,tick,wait,resume,run,drive,status,review,cancel,pause,self-test} ...`;
function argparseError(message) {
  process10.stderr.write(`${USAGE}
${PROGRAM}: error: ${message}
`);
  process10.exit(2);
}
function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process10.stdout.write(`${USAGE}

Run a bounded tick-based scheduler for fleet dispatch manifests.
`);
    process10.exit(0);
  }
  const command = argv.length ? String(argv[0]) : null;
  if (command === null) return { command: null, format: "text" };
  if (!Object.hasOwn(COMMANDS, command)) {
    argparseError(`argument command: invalid choice: '${command}' (choose from ${Object.keys(COMMANDS).map((item) => `'${item}'`).join(", ")})`);
  }
  const spec = COMMANDS[command];
  const args = { command };
  for (const item of Object.values(spec.values)) args[item.dest] = item.default;
  for (const dest of Object.values(spec.flags)) args[dest] = false;
  const seen = /* @__PURE__ */ new Set();
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = String(rest[index]);
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq > 0 ? token.slice(eq + 1) : null;
    if (Object.hasOwn(spec.flags, name)) {
      if (inlineValue !== null) argparseError(`argument ${name}: ignored explicit argument '${inlineValue}'`);
      args[spec.flags[name]] = true;
      seen.add(name);
      continue;
    }
    const item = Object.hasOwn(spec.values, name) ? spec.values[name] : null;
    if (!item) argparseError(`unrecognized arguments: ${token}`);
    let value = inlineValue;
    if (value === null) {
      index += 1;
      if (index >= rest.length) argparseError(`argument ${name}: expected one argument`);
      value = String(rest[index]);
    }
    if (item.choices && !item.choices.includes(value)) {
      argparseError(`argument ${name}: invalid choice: '${value}' (choose from ${item.choices.map((choice) => `'${choice}'`).join(", ")})`);
    }
    if (item.type === "int") {
      if (!/^[+-]?\d+$/.test(value.trim())) argparseError(`argument ${name}: invalid int value: '${value}'`);
      args[item.dest] = Number.parseInt(value.trim(), 10);
      seen.add(name);
      continue;
    }
    args[item.dest] = value;
    seen.add(name);
  }
  const missing = Object.entries(spec.values).filter(([name, item]) => item.required && !seen.has(name)).map(([name]) => name);
  if (missing.length) argparseError(`the following arguments are required: ${missing.join(", ")}`);
  if (spec.decisionGroup) {
    const chosen = spec.decisionGroup.filter((name) => args[spec.flags[name]]);
    if (chosen.length === 0) argparseError(`one of the arguments ${spec.decisionGroup.join(" ")} is required`);
    if (chosen.length > 1) argparseError(`argument ${chosen[1]}: not allowed with argument ${chosen[0]}`);
  }
  return args;
}
async function main() {
  const args = parseArgs(process10.argv.slice(2));
  const fmt = Object.hasOwn(args, "format") ? args.format : "text";
  try {
    if (args.command === "command-worker") return await runFleetCommand(args.spec);
    if (args.command === "cancel") {
      const root = stateRoot(args.state_root);
      const data = cancelRun(args.run_id, root, args.reason);
      if (data.status === "cancelling") data.driver = await launchDriver(args.run_id, root, 1e3);
      return emit(data, fmt, `fleet ${data.status}: ${data.run_id}`);
    }
    if (args.command === "start") {
      const dispatchOverrides = normalizeDispatchOverrides(args.async_context_mode);
      const data = startRun(
        args.manifest,
        args.run_id,
        stateRoot(args.state_root),
        args.force,
        dispatchOverrides
      );
      return emit(data, fmt, `fleet run started: ${data.run_id} (${data.nodes} nodes)`);
    }
    if (args.command === "pause") {
      const data = pauseRun(args.run_id, stateRoot(args.state_root), args.reason);
      return emit(data, fmt, `Fleet \u6682\u505C\u72B6\u6001\uFF1A${data.state}\uFF0Crun_id=${data.run_id}`);
    }
    if (args.command === "tick") {
      const data = tickRun(args.run_id, stateRoot(args.state_root), args.dry_run, args.verbose);
      const label = data.dry_run ? "would submit" : "submitted";
      return emit(data, fmt, `fleet tick ok: ${data.submitted.length} ${label}`);
    }
    if (args.command === "wait") {
      const data = waitRun(args.run_id, stateRoot(args.state_root), args.wait_ms, { verbose: args.verbose });
      return emit(
        data,
        fmt,
        `fleet wait ${data.event}: notices=${Object.hasOwn(data, "notice_count") ? data.notice_count : 0} active=${data.active}`
      );
    }
    if (args.command === "resume") {
      const data = resumeRun(args.run_id, stateRoot(args.state_root), {
        dryRun: args.dry_run,
        verbose: args.verbose
      });
      return emit(data, fmt, `fleet resume ok: ${args.run_id}`);
    }
    if (args.command === "run") {
      const root = stateRoot(args.state_root);
      let runId;
      if (args.manifest) {
        const dispatchOverrides = normalizeDispatchOverrides(args.async_context_mode);
        const started = startRun(args.manifest, args.run_id, root, args.force, dispatchOverrides);
        runId = String(started.run_id);
      } else {
        if (!args.run_id) throw new ToolError("run requires --manifest for a new run or --run-id to resume");
        if (args.async_context_mode) {
          throw new ToolError("dispatch overrides are fixed when the run starts; omit them when resuming");
        }
        runId = safeId(args.run_id);
      }
      const data = await launchDriver(runId, root, args.wait_ms);
      return emit(data, fmt, `fleet driver launched: ${runId} pid=${data.pid}`);
    }
    if (args.command === "drive") {
      const data = driveRun(args.run_id, stateRoot(args.state_root), args.wait_ms);
      return emit(data, fmt, `fleet driver ${data.status}: ${args.run_id}`);
    }
    if (args.command === "status") {
      const data = statusRun(args.run_id, stateRoot(args.state_root), args.summary);
      const text3 = args.summary ? formatStatusSummary(data) : `fleet status ok: ${pyJsonDumps(data.counts)}`;
      return emit(data, fmt, text3);
    }
    if (args.command === "review") {
      const decisionValue = args.accept ? "accepted" : args.block ? "blocked" : "requeued";
      const reviewRoot2 = stateRoot(args.state_root);
      const data = reviewRun(
        args.run_id,
        reviewRoot2,
        args.node_id,
        decisionValue,
        args.evidence,
        args.reason
      );
      const reviewedState = loadJson(statePath(reviewRoot2, args.run_id));
      const unfinished = (Array.isArray(reviewedState.nodes) ? reviewedState.nodes : []).some(
        (node) => node && typeof node === "object" && !Array.isArray(node) && !TERMINAL_STATES.has(node.state)
      );
      if (unfinished) {
        data.driver = await launchDriver(args.run_id, reviewRoot2, 6e4);
      }
      return emit(data, fmt, `fleet review ${decisionValue}: ${data.node_id} -> ${data.node_state}`);
    }
    if (args.command === "self-test") {
      const data = selfTest();
      return emit(data, fmt, `fleet_scheduler self-test ${data.status}`);
    }
    throw new ToolError("choose a command: start, tick, wait, resume, run, drive, status, review, cancel, pause, self-test");
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    return emit({ status: "failed", error: String(error.message) }, fmt, `failed: ${error.message}`);
  }
}
process10.exitCode = await main();
