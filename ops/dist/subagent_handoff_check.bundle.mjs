#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
import process from "node:process";
function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function samePath(left, right) {
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process.platform === "win32" ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US") : normalizedLeft === normalizedRight;
}
function isInsideProject(target, projectRoot2) {
  const normalizedTarget = process.platform === "win32" ? path.resolve(target).toLocaleLowerCase("en-US") : path.resolve(target);
  const normalizedRoot = process.platform === "win32" ? path.resolve(projectRoot2).toLocaleLowerCase("en-US") : path.resolve(projectRoot2);
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
var tool_common_exports = {};
__export(tool_common_exports, {
  PROJECT_ROOT: () => PROJECT_ROOT,
  ROLE_NAME_RE: () => ROLE_NAME_RE,
  ROOT: () => ROOT,
  RUNTIME_ROOT: () => RUNTIME_ROOT,
  ToolError: () => ToolError,
  absolutePath: () => absolutePath,
  add: () => add,
  asList: () => asList,
  assertNoReparseComponents: () => assertNoReparseComponents,
  assertRegularFile: () => assertRegularFile,
  atomicWriteBytes: () => atomicWriteBytes,
  canonicalJson: () => canonicalJson,
  canonicalValue: () => canonicalValue,
  clock: () => clock,
  decodeStdinBytes: () => decodeStdinBytes,
  emit: () => emit,
  ensureControlledDirectory: () => ensureControlledDirectory,
  fileFingerprint: () => fileFingerprint,
  freezeDeterminism: () => freezeDeterminism,
  homeDir: () => homeDir,
  ids: () => ids,
  isAbsoluteLikePython: () => isAbsoluteLikePython,
  isRecord: () => isRecord,
  isReparseStat: () => isReparseStat,
  isSameOrInside: () => isSameOrInside,
  issueText: () => issueText,
  lexicalAbsolute: () => lexicalAbsolute,
  loadJson: () => loadJson,
  loadRoleConfig: () => loadRoleConfig,
  modelConfigSources: () => modelConfigSources,
  normalizeConflictPath: () => normalizeConflictPath,
  pathConflict: () => pathConflict,
  pathlibJoin: () => pathlibJoin,
  projectRoot: () => projectRoot,
  pyError: () => pyError,
  readStdinText: () => readStdinText,
  rel: () => rel,
  repoPath: () => repoPath,
  repoRoot: () => repoRoot,
  resetDeterminism: () => resetDeterminism,
  resolveLikePython: () => resolveLikePython,
  roleConfigPath: () => roleConfigPath,
  runGit: () => runGit,
  runtimeAssetPath: () => runtimeAssetPath,
  runtimeRoot: () => runtimeRoot,
  sha256Hex: () => sha256Hex,
  statusLines: () => statusLines,
  utcDateStamp: () => utcDateStamp,
  utcNow: () => utcNow
});
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
import { spawnSync } from "node:child_process";
import os from "node:os";
import path2 from "node:path";
import process2 from "node:process";
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
function freezeDeterminism({ nowIso, uuidSeed }) {
  const text2 = String(nowIso);
  const nowMs = Date.parse(text2);
  if (!Number.isFinite(nowMs)) throw new TypeError(`freezeDeterminism requires a parseable nowIso: ${nowIso}`);
  const fraction = /\.(\d{1,6})(?=[+Z-]|$)/.exec(text2)?.[1] ?? null;
  frozen = {
    nowMs,
    micros: fraction === null ? null : fraction.padEnd(6, "0"),
    uuidSeed: String(uuidSeed ?? "golden"),
    uuidIndex: 0
  };
}
function resetDeterminism() {
  frozen = null;
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
  const text2 = String(value ?? "");
  if (process2.platform !== "win32") return text2.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text2) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text2);
}
function pathlibJoin(base, other) {
  const text2 = String(other ?? "");
  if (isAbsoluteLikePython(text2)) return text2;
  if (process2.platform === "win32" && /^[\\/]/.test(text2)) {
    const drive = path2.parse(path2.resolve(String(base))).root.replace(/[\\/]+$/, "");
    return `${drive}${text2}`;
  }
  return path2.join(String(base), text2);
}
function resolveLikePython(value) {
  const absolute = path2.resolve(String(value));
  let current = absolute;
  const tail = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? path2.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path2.dirname(current);
      if (parent === current) return absolute;
      tail.push(path2.basename(current));
      current = parent;
    }
  }
}
function repoRoot() {
  const explicit = String(process2.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
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
  let cur = resolveLikePython(process2.cwd());
  while (true) {
    if (existsSync2(path2.join(cur, ".git")) || existsSync2(path2.join(cur, "AGENTS.md")) && existsSync2(path2.join(cur, "ops"))) {
      return cur;
    }
    const parent = path2.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new ToolError(`cannot locate cockpit repository root from ${resolveLikePython(process2.cwd())}`);
}
function declaredDirectory(envKey) {
  const explicit = String(process2.env[envKey] || "").trim();
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
  if (String(process2.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd = resolveLikePython(process2.cwd());
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
  if (String(process2.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
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
function runtimeAssetPath(...segments) {
  return path2.join(RUNTIME_ROOT, ...segments.map(String));
}
function loadRoleConfig(role, { globalDefault = false } = {}) {
  const selectedFile = roleConfigPath(role);
  const file = globalDefault ? path2.join(modelConfigSources().global_root, "ops", "agents", path2.basename(selectedFile)) : selectedFile;
  let text2;
  try {
    text2 = readFileSync2(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ToolError(`runtime role config not found: ${rel(file)}`);
    throw new ToolError(`runtime role config is unreadable: ${rel(file)}`);
  }
  let data;
  try {
    data = parse(text2);
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
function runGit(args, cwd = ROOT) {
  const cmd = ["git", ...args.map(String)];
  const proc = spawnSync("git", args.map(String), { cwd, encoding: "utf8", windowsHide: true });
  if (proc.error) {
    if (proc.error.code === "ENOENT") throw new ToolError("git executable not found");
    throw new ToolError(`git failed to start: ${proc.error.message}`);
  }
  return {
    command: cmd,
    exit_code: proc.status ?? 1,
    stdout: String(proc.stdout ?? "").replace(/\n+$/, ""),
    stderr: String(proc.stderr ?? "").replace(/\n+$/, "")
  };
}
function loadJson(file) {
  let text2;
  try {
    text2 = readFileSync2(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ToolError(`json file not found: ${rel(file)}`);
    throw new ToolError(`cannot read json file: ${rel(file)}`);
  }
  let data;
  try {
    data = JSON.parse(text2);
  } catch (error) {
    throw new ToolError(`invalid json file: ${rel(file)}:${jsonErrorLine(text2, error)}`);
  }
  if (!isRecord(data)) throw new ToolError(`json root is not object: ${rel(file)}`);
  return data;
}
function jsonErrorLine(text2, error) {
  const match = /position (\d+)/.exec(String(error?.message ?? ""));
  if (!match) return 1;
  return text2.slice(0, Number(match[1])).split("\n").length;
}
function fileFingerprint(file) {
  let info;
  try {
    info = statSync2(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: rel(file), exists: false };
    throw new ToolError(`cannot stat path: ${rel(file)}`);
  }
  const mtime = Math.floor(info.mtimeMs / 1e3);
  return {
    path: rel(file),
    exists: true,
    size: info.size,
    mtime,
    mtime_iso: localTimeString(mtime)
  };
}
function localTimeString(epochSeconds) {
  const d = new Date(epochSeconds * 1e3);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
function emit(data, fmt, text2) {
  if (fmt === "json") {
    process2.stdout.write(`${canonicalJson(data)}
`);
  } else {
    const trimmed = String(text2 ?? "").replace(/\s+$/, "");
    process2.stdout.write(`${trimmed || "(empty)"}
`);
  }
  if (Object.hasOwn(data, "exit_code")) return Number(data.exit_code);
  return ["failed", "error"].includes(data.status) ? 1 : 0;
}
function statusLines() {
  const status = runGit(["status", "--short", "--untracked-files=all"]);
  if (status.exit_code !== 0) throw new ToolError(`git status failed: ${status.stderr}`);
  if (!status.stdout) return [];
  return status.stdout.split(/\r?\n/).filter((line) => line.trim());
}
function repoPath(value, label, { mustExist = true } = {}) {
  const raw = String(value);
  const lexical = isAbsoluteLikePython(raw) ? path2.resolve(raw) : path2.resolve(ROOT, raw);
  const projectReal = resolveLikePython(ROOT);
  const lexicalRelative = path2.relative(projectReal, lexical);
  if (lexicalRelative.startsWith("..") || path2.isAbsolute(lexicalRelative)) {
    throw new ToolError(`${label} escapes repository: ${value}`);
  }
  const resolved = resolveLikePython(lexical);
  const relative = path2.relative(projectReal, resolved);
  if (relative.startsWith("..") || path2.isAbsolute(relative)) {
    if (!isSameOrInside(resolved, RUNTIME_ROOT)) throw new ToolError(`${label} escapes repository: ${value}`);
  }
  if (mustExist) {
    let info = null;
    try {
      info = statSync2(resolved);
    } catch {
      info = null;
    }
    if (!info || !info.isFile()) throw new ToolError(`${label} is not a readable file: ${value}`);
  }
  return resolved;
}
function isSameOrInside(candidate, root) {
  if (!candidate || !root) return false;
  const target = resolveLikePython(candidate);
  const base = resolveLikePython(root);
  const relative = path2.relative(base, target);
  return relative === "" || !relative.startsWith("..") && !path2.isAbsolute(relative);
}
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function readStdinText(sourceLabel) {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  while (true) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EAGAIN") continue;
      if (error?.code === "EOF") break;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return decodeStdinBytes(Buffer.concat(chunks), sourceLabel);
}
function decodeStdinBytes(raw, sourceLabel) {
  if (raw.length >= 3 && raw[0] === 239 && raw[1] === 187 && raw[2] === 191) return raw.subarray(3).toString("utf8");
  if (raw.length >= 2 && raw[0] === 255 && raw[1] === 254) return raw.subarray(2).toString("utf16le");
  if (raw.length >= 2 && raw[0] === 254 && raw[1] === 255) return swapUtf16(raw.subarray(2)).toString("utf16le");
  const utf8 = raw.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  if (raw.length % 2 === 0) return raw.toString("utf16le");
  throw new ToolError(`invalid ${sourceLabel} input encoding; expected UTF-8, UTF-16 or locale text`);
}
function swapUtf16(buffer) {
  const swapped = Buffer.from(buffer);
  swapped.swap16();
  return swapped;
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
function asList(value) {
  return Array.isArray(value) ? value : [];
}
function add(issues, code, location) {
  issues.push({ code, message: location });
}
function issueText(issue) {
  return `${issue?.code ?? ""}: ${issue?.message ?? ""}`;
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
var ToolError, frozen, clock, ids, ROOT, PROJECT_ROOT, RUNTIME_ROOT, ROLE_NAME_RE, modelConfigCache;
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
    PROJECT_ROOT = ROOT;
    RUNTIME_ROOT = runtimeRoot();
    ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
    modelConfigCache = null;
  }
});

// ops/tools/dispatch-core/_py.mjs
var py_exports = {};
__export(py_exports, {
  PY_ALNUM_RE: () => PY_ALNUM_RE,
  PY_SPACE_CLASS: () => PY_SPACE_CLASS,
  PY_SPACE_RE: () => PY_SPACE_RE,
  isRecord: () => isRecord,
  pyCasefold: () => pyCasefold,
  pyError: () => pyError,
  pyFloat: () => pyFloat,
  pyGet: () => pyGet,
  pyGetItem: () => pyGetItem,
  pyIsAbsolute: () => isAbsoluteLikePython,
  pyIsRelativeTo: () => pyIsRelativeTo,
  pyJsonDumps: () => pyJsonDumps,
  pyJsonLoads: () => pyJsonLoads,
  pyKeyError: () => pyKeyError,
  pyLStrip: () => pyLStrip,
  pyNormcase: () => pyNormcase,
  pyOr: () => pyOr,
  pyPathJoin: () => pathlibJoin,
  pyPureStr: () => pyPureStr,
  pyRStrip: () => pyRStrip,
  pyRStripChars: () => pyRStripChars,
  pyReadText: () => pyReadText,
  pyReadTextReplace: () => pyReadTextReplace,
  pyRelativeTo: () => pyRelativeTo,
  pyRelativeToPosix: () => pyRelativeToPosix,
  pyRepr: () => pyRepr,
  pyResolveUnder: () => pyResolveUnder,
  pySamePath: () => pySamePath,
  pySpawnSync: () => pySpawnSync,
  pySplitLines: () => pySplitLines,
  pyStr: () => pyStr,
  pyStrip: () => pyStrip,
  pyStripChars: () => pyStripChars,
  pyTruthy: () => pyTruthy,
  pyTypeName: () => pyTypeName
});
import { spawnSync as spawnSync2 } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
import path3 from "node:path";
import process3 from "node:process";
function pyStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "").replace(RE_RSTRIP, "");
}
function pyLStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "");
}
function pyRStrip(value) {
  return String(value ?? "").replace(RE_RSTRIP, "");
}
function pyStripChars(value, chars) {
  const text2 = String(value ?? "");
  let start = 0;
  let end = text2.length;
  while (start < end && chars.includes(text2[start])) start += 1;
  while (end > start && chars.includes(text2[end - 1])) end -= 1;
  return text2.slice(start, end);
}
function pyRStripChars(value, chars) {
  const text2 = String(value ?? "");
  let end = text2.length;
  while (end > 0 && chars.includes(text2[end - 1])) end -= 1;
  return text2.slice(0, end);
}
function pyCasefold(value) {
  let out = "";
  for (const ch of String(value ?? "").toLowerCase()) out += CASEFOLD_EXTRA.get(ch) ?? ch;
  return out;
}
function pySplitLines(value) {
  const text2 = String(value ?? "");
  if (!text2) return [];
  const parts = text2.split(RE_LINE_BOUNDARY);
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
  const text2 = String(value);
  const quote = text2.includes("'") && !text2.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text2) {
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
    const text2 = pyStrip(value).replace(/(?<=[0-9])_(?=[0-9])/g, "");
    if (/^[+-]?(?:inf|infinity)$/i.test(text2)) return text2.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(text2)) return Number.NaN;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text2)) {
      throw pyError("ValueError", `could not convert string to float: ${pyRepr(value)}`);
    }
    return Number(text2);
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
function pyJsonLoads(text2) {
  const s = String(text2);
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
  let text2;
  try {
    text2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw pyError("UnicodeDecodeError", `'utf-8' codec can't decode file: ${String(file)}`);
  }
  return text2.replace(/\r\n?/g, "\n");
}
function pyReadTextReplace(file) {
  return readFileSync3(file, "utf8").replace(/\r\n?/g, "\n");
}
function pyNormcase(value) {
  const text2 = String(value);
  return process3.platform === "win32" ? text2.replace(/\//g, "\\").toLowerCase() : text2;
}
function pySamePath(left, right) {
  return pyNormcase(left) === pyNormcase(right);
}
function pathAnchor(root) {
  if (process3.platform !== "win32") return root;
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
  return anchor + parts.join(process3.platform === "win32" ? "\\" : "/");
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
  const tail = pathParts(child).parts.slice(pathParts(parent).parts.length);
  return tail.length ? tail.join("/") : ".";
}
function pyRelativeTo(child, parent) {
  return pyIsRelativeTo(child, parent) ? pyRelativeToPosix(child, parent) : null;
}
function pyResolveUnder(value, base) {
  return resolveLikePython(pathlibJoin(base, value));
}
function pySpawnSync(command, args, options) {
  const cmd = String(command);
  if (process3.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    const quote = (value) => {
      const text2 = String(value);
      return /[\s"^&|<>()%!]/.test(text2) ? `"${text2.replace(/"/g, '\\"')}"` : text2;
    };
    const line = [cmd, ...args].map(quote).join(" ");
    return spawnSync2(line, [], { ...options, shell: true });
  }
  return spawnSync2(cmd, args, options);
}
var PY_SPACE_CLASS, PY_SPACE_RE, PY_ALNUM_RE, RE_LSTRIP, RE_RSTRIP, RE_LINE_BOUNDARY, CASEFOLD_EXTRA, NON_PRINTABLE_RE, JSON_WS, JSON_BACKSLASH, JSON_NUMBER_RE, ScanStop;
var init_py = __esm({
  "ops/tools/dispatch-core/_py.mjs"() {
    init_tool_common();
    PY_SPACE_CLASS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
    PY_SPACE_RE = new RegExp(`[${PY_SPACE_CLASS}]`);
    PY_ALNUM_RE = /[\p{L}\p{N}]/u;
    RE_LSTRIP = new RegExp(`^[${PY_SPACE_CLASS}]+`);
    RE_RSTRIP = new RegExp(`[${PY_SPACE_CLASS}]+$`);
    RE_LINE_BOUNDARY = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;
    CASEFOLD_EXTRA = /* @__PURE__ */ new Map([
      ["\xDF", "ss"],
      ["\uFB00", "ff"],
      ["\uFB01", "fi"],
      ["\uFB02", "fl"],
      ["\uFB03", "ffi"],
      ["\uFB04", "ffl"],
      ["\uFB05", "st"],
      ["\uFB06", "st"],
      ["\u03C2", "\u03C3"],
      ["\u03D0", "\u03B2"],
      ["\u03D1", "\u03B8"],
      ["\u03D5", "\u03C6"],
      ["\u03D6", "\u03C0"],
      ["\u03F0", "\u03BA"],
      ["\u03F1", "\u03C1"],
      ["\u03F5", "\u03B5"],
      ["\u1E9B", "\u1E61"],
      ["\uFB13", "\u0574\u0576"],
      ["\uFB14", "\u0574\u0565"],
      ["\uFB15", "\u0574\u056B"],
      ["\uFB16", "\u057E\u0576"],
      ["\uFB17", "\u0574\u056D"]
    ]);
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

// ops/tools/dispatch-core/subagent_handoff_check.mjs
var subagent_handoff_check_exports = {};
__export(subagent_handoff_check_exports, {
  NON_PATH_EVIDENCE_LABELS: () => NON_PATH_EVIDENCE_LABELS,
  acceptedVerdicts: () => acceptedVerdicts,
  buildText: () => buildText,
  businessGateValue: () => businessGateValue,
  candidatePackagePaths: () => candidatePackagePaths,
  checkHandoff: () => checkHandoff,
  extractFinalHandoff: () => extractFinalHandoff,
  firstField: () => firstField,
  loadJson: () => loadJson2,
  loadTaskPackageById: () => loadTaskPackageById,
  looksLikePath: () => looksLikePath,
  missingPaths: () => missingPaths,
  missingRequiredSections: () => missingRequiredSections,
  nestedScalarField: () => nestedScalarField,
  normalizeRefPath: () => normalizeRefPath,
  normalizeSection: () => normalizeSection,
  reportHeadings: () => reportHeadings,
  runSelfTest: () => runSelfTest,
  safePackageFilename: () => safePackageFilename,
  sameResolvedPath: () => sameResolvedPath,
  scalarFields: () => scalarFields,
  sectionItems: () => sectionItems,
  targetRoot: () => targetRoot,
  taskBusinessGate: () => taskBusinessGate,
  taskCapability: () => taskCapability,
  taskExpectedOutputFile: () => taskExpectedOutputFile,
  taskExpectedResolvedFile: () => taskExpectedResolvedFile,
  taskGateValues: () => taskGateValues,
  taskHandoffResolvedFile: () => taskHandoffResolvedFile,
  taskPath: () => taskPath,
  taskRequiredSections: () => taskRequiredSections,
  taskTargetRepo: () => taskTargetRepo,
  validateCapabilityBusinessGate: () => validateCapabilityBusinessGate,
  validationBoolOk: () => validationBoolOk
});
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync, rmSync, statSync as statSync3, unlinkSync as unlinkSync2, writeFileSync } from "node:fs";
import path4 from "node:path";
import process4 from "node:process";
function comparePythonStrings(left, right) {
  const a = [...String(left)];
  const b = [...String(right)];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = a[index].codePointAt(0);
    const y = b[index].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}
function sortedUnique(values) {
  return [...new Set(values)].sort(comparePythonStrings);
}
function resolveAgainstRoot(value) {
  const text2 = String(value ?? "");
  return isAbsoluteLikePython(text2) ? resolveLikePython(text2) : resolveLikePython(path4.resolve(ROOT, text2));
}
function targetRoot(taskPackage) {
  const runtime = pyGet(taskPackage, "runtime_context");
  const target = isRecord(runtime) ? pyGet(runtime, "target_repo") : void 0;
  if (target === null || target === void 0 || target === "") return resolveLikePython(ROOT);
  if (typeof target !== "string" || !pyStrip(target)) {
    throw new ToolError("runtime_context.target_repo must be a non-empty string when set");
  }
  if (!isAbsoluteLikePython(target)) throw new ToolError("runtime_context.target_repo must be an absolute path");
  const resolved = resolveLikePython(target);
  if (!existsSync3(resolved)) throw new ToolError(`runtime_context.target_repo not found: ${target}`);
  let info;
  try {
    info = statSync3(resolved);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) throw new ToolError(`runtime_context.target_repo is not a directory: ${target}`);
  return resolved;
}
function taskPath(value, taskPackage, { label, mustExist = false } = {}) {
  const resolved = resolveAgainstRoot(value);
  if (mustExist && !existsSync3(resolved)) throw new ToolError(`${label} not found: ${rel(resolved)}`);
  return resolved;
}
function loadJson2(file) {
  const data = loadJson(file);
  const taskPackage = pyGet(data, "task_package");
  return isRecord(taskPackage) ? taskPackage : data;
}
function safePackageFilename(packageId) {
  let out = "";
  for (const ch of String(packageId ?? "")) {
    out += PY_ALNUM_RE.test(ch) || "._:-".includes(ch) ? ch : "-";
  }
  return [...out].slice(0, 120).join("");
}
function listDirectory(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
function mtimeNs(file) {
  try {
    return statSync3(file, { bigint: true }).mtimeNs;
  } catch {
    return 0n;
  }
}
function candidatePackagePaths(packageId) {
  const safe = safePackageFilename(packageId);
  const candidates = [
    path4.join(ROOT, "tmp", "dispatch_prepare", `${safe}.task-package.json`),
    path4.join(ROOT, "notes", "manifests", `${safe}.task-package.json`)
  ];
  for (const root of [path4.join(ROOT, "tmp", "dispatch_prepare"), path4.join(ROOT, "notes", "manifests")]) {
    if (!existsSync3(root)) continue;
    for (const name of listDirectory(root)) {
      if (!name.endsWith(".json")) continue;
      if (!String(name).includes(packageId)) continue;
      candidates.push(path4.join(root, name));
    }
  }
  const preparationRoot = path4.join(ROOT, "tmp", "dispatch_prepare", "preparations");
  if (existsSync3(preparationRoot)) {
    const preparationPackages = [];
    for (const name of listDirectory(preparationRoot)) {
      if (!name.startsWith("prep-")) continue;
      const candidate = path4.join(preparationRoot, name, "package.json");
      if (existsSync3(candidate)) preparationPackages.push(candidate);
    }
    preparationPackages.sort((left, right) => {
      const a = mtimeNs(left);
      const b = mtimeNs(right);
      if (a === b) return 0;
      return a < b ? 1 : -1;
    });
    candidates.push(...preparationPackages);
  }
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const candidate of candidates) {
    const resolved = resolveLikePython(candidate);
    const key = process4.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
function loadTaskPackageById(packageId) {
  const checked = [];
  for (const candidate of candidatePackagePaths(packageId)) {
    checked.push(rel(candidate));
    if (!existsSync3(candidate)) continue;
    let taskPackage;
    try {
      taskPackage = loadJson2(candidate);
    } catch (error) {
      if (error instanceof ToolError || error?.name === "ToolError") continue;
      throw error;
    }
    if (String(pyGet(taskPackage, "package_id") || "") === packageId) return [candidate, taskPackage];
  }
  throw new ToolError(`task package not found for package_id=${packageId}; checked=${checked.join(", ")}`);
}
function scalarFields(text2) {
  const fields = /* @__PURE__ */ Object.create(null);
  for (const line of pySplitLines(text2)) {
    const stripped = pyStrip(line);
    if (!stripped || stripped.startsWith("- ") || stripped.endsWith(":")) continue;
    if (!stripped.includes(":")) continue;
    const separator = stripped.indexOf(":");
    const key = pyStrip(stripped.slice(0, separator));
    const rawValue = stripped.slice(separator + 1);
    if (!key || PY_SPACE_RE.test(key)) continue;
    const value = pyStripChars(pyStrip(rawValue), "\"'`");
    if (["", "null", "none", "~"].includes(value.toLowerCase())) continue;
    if (!Object.hasOwn(fields, key)) fields[key] = [];
    fields[key].push(value);
  }
  return fields;
}
function firstField(fields, ...names) {
  for (const name of names) {
    const values = (fields && typeof fields === "object" && Object.hasOwn(fields, name) ? fields[name] : null) || [];
    if (values.length) return values[0];
  }
  return "";
}
function nestedScalarField(text2, section, field) {
  const lines = pySplitLines(text2).filter((line) => pyStrip(line));
  const indentOf = (line) => line.length - pyLStrip(line).length;
  const baseIndent = lines.length > 1 ? indentOf(lines[1]) : 0;
  const start = lines.findIndex((line, index) => index > 0 && indentOf(line) === baseIndent && pyStrip(line) === `${section}:`);
  if (start < 0) return "";
  const childIndent = start + 1 < lines.length ? indentOf(lines[start + 1]) : 0;
  for (const line of lines.slice(start + 1)) {
    const indent = indentOf(line);
    if (indent <= baseIndent) break;
    if (indent !== childIndent) continue;
    const stripped = pyStrip(line);
    if (stripped.startsWith("- ") || stripped.endsWith(":")) continue;
    if (!stripped.includes(":")) continue;
    const separator = stripped.indexOf(":");
    const key = stripped.slice(0, separator);
    const rawValue = stripped.slice(separator + 1);
    if (pyStrip(key) !== field) continue;
    const value = pyStripChars(pyStrip(rawValue), "\"'`");
    if (["", "null", "none", "~"].includes(value.toLowerCase())) return "";
    return value;
  }
  return "";
}
function extractFinalHandoff(text2) {
  const marker = "FINAL_HANDOFF:";
  const value = String(text2 ?? "");
  const index = value.lastIndexOf(marker);
  if (index < 0) return "";
  return pyStrip(value.slice(index));
}
function sectionItems(text2, name) {
  const lines = pySplitLines(text2);
  let start = -1;
  let baseIndent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = pyStrip(lines[index]);
    if (stripped === `${name}:`) {
      start = index;
      baseIndent = lines[index].length - pyLStrip(lines[index]).length;
      break;
    }
  }
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!pyStrip(line)) continue;
    const indent = line.length - pyLStrip(line).length;
    if (indent <= baseIndent && !pyLStrip(line).startsWith("- ")) break;
    const stripped = pyStrip(line);
    if (stripped.startsWith("- ")) {
      const value = pyStripChars(pyStrip(stripped.slice(2)), "\"'`");
      if (value) items.push(value);
    }
  }
  return items;
}
function taskExpectedOutputFile(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (isRecord(expected) && String(pyGet(expected, "mode") || "") === "file") {
    return String(pyGet(expected, "resolved_file_path") || pyGet(expected, "file_path") || "");
  }
  return "";
}
function taskExpectedResolvedFile(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (isRecord(expected) && String(pyGet(expected, "mode") || "") === "file") {
    return String(pyGet(expected, "resolved_file_path") || "");
  }
  return "";
}
function taskHandoffResolvedFile(taskPackage) {
  const handoff = pyGet(taskPackage, "handoff_contract");
  if (isRecord(handoff)) return String(pyGet(handoff, "resolved_handoff_file") || "");
  return "";
}
function taskTargetRepo(taskPackage) {
  const runtime = pyGet(taskPackage, "runtime_context");
  if (!isRecord(runtime)) return "";
  return String(pyGet(runtime, "target_repo") || "");
}
function taskBusinessGate(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (!isRecord(expected)) return "";
  return pyStrip(String(pyGet(expected, "business_gate") || ""));
}
function taskCapability(taskPackage) {
  const agent = pyGet(taskPackage, "agent");
  if (!isRecord(agent)) return ["", ""];
  const role = pyStrip(String(pyGet(agent, "role") || ""));
  const capability = pyGet(agent, "capability");
  if (!isRecord(capability)) return [role, ""];
  return [role, pyStrip(String(pyGet(capability, "name") || ""))];
}
function businessGateValue(handoff, fields, businessGate) {
  const gate = String(businessGate ?? "");
  const leaf = gate.startsWith("FINAL_HANDOFF.output.") ? gate.slice(gate.lastIndexOf(".") + 1) : gate;
  return nestedScalarField(handoff, "output", leaf);
}
function taskGateValues(taskPackage) {
  const extensions = pyGet(taskPackage, "extensions");
  if (!isRecord(extensions)) return [];
  const contract = pyGet(extensions, "capability_contract");
  if (!isRecord(contract)) return [];
  for (const slot of Object.values(contract)) {
    if (!isRecord(slot)) continue;
    const raw = String(pyGet(slot, "gate_values") || "");
    if (!raw) continue;
    return sortedUnique(raw.split("|").map((item) => pyStrip(item)).filter((item) => item));
  }
  return [];
}
function validateCapabilityBusinessGate(taskPackage, handoff, fields, businessGate) {
  const [role, capability] = taskCapability(taskPackage);
  if (role !== "plan-checker" || capability !== "plan-review" || businessGate !== "FINAL_HANDOFF.output.overall") {
    return [];
  }
  const value = businessGateValue(handoff, fields, businessGate);
  if (!value) return [];
  const allowed = ["APPROVED", "APPROVED_WITH_FLAGS", "BLOCKED"];
  if (!allowed.includes(value)) {
    return [`FINAL_HANDOFF.output.overall_invalid=${value}; expected one of ${[...allowed].sort(comparePythonStrings).join(", ")}`];
  }
  return [];
}
function taskRequiredSections(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (!isRecord(expected)) return [];
  const sections = pyGet(expected, "required_sections");
  if (!Array.isArray(sections)) return [];
  return sections.map((item) => pyStrip(String(item))).filter((item) => item);
}
function normalizeSection(value) {
  let out = "";
  for (const ch of pyCasefold(pyStrip(value))) {
    if (PY_ALNUM_RE.test(ch)) out += ch;
  }
  return out;
}
function reportHeadings(text2) {
  const headings = [];
  for (const line of pySplitLines(text2)) {
    const match = /^[\s]{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const raw = pyStripChars(pyStripChars(pyStrip(match[1]), "#"), "`*_ ");
    const normalized = normalizeSection(raw);
    if (normalized) headings.push(normalized);
  }
  return sortedUnique(headings);
}
function missingRequiredSections(expectedFile, requiredSections, taskPackage) {
  if (!expectedFile || !requiredSections || !requiredSections.length) return [];
  let headings;
  try {
    const target = taskPath(expectedFile, taskPackage, { label: "expected_output.file_path", mustExist: true });
    headings = reportHeadings(pyReadTextReplace(target));
  } catch (error) {
    if (error instanceof ToolError || error?.name === "ToolError") return requiredSections;
    throw error;
  }
  const missing = [];
  for (const section of requiredSections) {
    if (!headings.includes(normalizeSection(section))) missing.push(section);
  }
  return missing;
}
function looksLikePath(value) {
  const text2 = pyStripChars(pyStrip(value), "\"'`");
  if (!text2 || text2 === "FINAL_HANDOFF" || text2 === "-") return false;
  const labelMatch = /^([A-Za-z][A-Za-z0-9_-]*)\|/.exec(text2);
  if (labelMatch && NON_PATH_EVIDENCE_LABELS.has(labelMatch[1].toUpperCase())) return false;
  const lowered = text2.toLowerCase();
  for (const prefix of ["http://", "https://", "command:", "cmd:", "shell:", "powershell:", "bash:"]) {
    if (lowered.startsWith(prefix)) return false;
  }
  if (text2.startsWith("`") || text2.startsWith("$")) return false;
  if (text2.includes("/") || text2.includes("\\")) return true;
  return [".md", ".json", ".yaml", ".yml", ".txt", ".csv"].some((suffix) => text2.endsWith(suffix));
}
function normalizeRefPath(value) {
  let text2 = pyStripChars(pyStrip(value), "\"'`");
  const labelMatch = new RegExp(`^[A-Za-z][\\p{L}\\p{N}_-]*:[${PY_SPACE_CLASS}]+([^${PY_SPACE_CLASS}].*)$`, "u").exec(text2);
  if (labelMatch) text2 = pyStripChars(pyStrip(labelMatch[1]), "\"'`");
  const separator = text2.lastIndexOf(":");
  if (separator >= 0) {
    const suffix = pyStrip(text2.slice(separator + 1));
    if (/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(suffix)) text2 = text2.slice(0, separator);
  }
  return text2;
}
function missingPaths(values, taskPackage) {
  const missing = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    if (!looksLikePath(value)) continue;
    const candidate = normalizeRefPath(value);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let candidates;
    if (isAbsoluteLikePython(candidate)) {
      candidates = [resolveLikePython(candidate)];
    } else {
      candidates = [resolveLikePython(path4.resolve(ROOT, candidate))];
      let target;
      try {
        target = targetRoot(taskPackage);
      } catch (error) {
        if (!(error instanceof ToolError || error?.name === "ToolError")) throw error;
        target = resolveLikePython(ROOT);
      }
      if (!pySamePath(target, resolveLikePython(ROOT))) {
        candidates.push(resolveLikePython(path4.resolve(target, candidate)));
      }
    }
    if (!candidates.some((item) => existsSync3(item))) missing.push(candidate);
  }
  return missing;
}
function acceptedVerdicts(taskPackage) {
  const handoffContract = pyGet(taskPackage, "handoff_contract");
  const values = isRecord(handoffContract) ? pyGet(handoffContract, "accept_verdicts") : null;
  if (!Array.isArray(values)) return [];
  return values.map((value) => pyStrip(String(value))).filter((value) => value);
}
function validationBoolOk(value) {
  return ["true", "false"].includes(pyCasefold(pyStrip(value)));
}
function sameResolvedPath(value, expected) {
  if (!value || !expected) return false;
  return pySamePath(resolveAgainstRoot(value), resolveLikePython(expected));
}
function checkHandoff(taskPackage, handoffText, { actualHandoffPath = null } = {}) {
  const handoff = extractFinalHandoff(handoffText);
  const issues = [];
  const diagnostics = [];
  let fields;
  if (!handoff) {
    issues.push("missing_FINAL_HANDOFF");
    fields = /* @__PURE__ */ Object.create(null);
  } else {
    fields = scalarFields(handoff);
  }
  try {
    targetRoot(taskPackage);
  } catch (error) {
    if (!(error instanceof ToolError || error?.name === "ToolError")) throw error;
    issues.push(error.message);
  }
  const taskPackageId = String(pyGet(taskPackage, "package_id") || "");
  const handoffPackageId = firstField(fields, "package_id");
  if (!taskPackageId) issues.push("task_package.package_id_missing");
  if (!handoffPackageId) issues.push("FINAL_HANDOFF.package_id_missing");
  if (taskPackageId && handoffPackageId && taskPackageId !== handoffPackageId) {
    issues.push(`package_id_mismatch task_package=${taskPackageId} handoff=${handoffPackageId}`);
  }
  const verdict = firstField(fields, "verdict");
  if (!verdict) issues.push("FINAL_HANDOFF.verdict_missing");
  const accepted = acceptedVerdicts(taskPackage);
  if (!accepted.length) {
    issues.push("task_package.handoff_contract.accept_verdicts_missing");
  } else if (verdict && !accepted.includes(verdict)) {
    issues.push(`FINAL_HANDOFF.verdict_invalid=${verdict}`);
  }
  const needsOwnerExit = verdict === "needs_owner";
  const incompleteExit = ["needs_owner", "partial", "needs_split"].includes(verdict);
  for (const field of ["required_files_loaded", "expected_output_satisfied", "scope_compliant"]) {
    const value = firstField(fields, field);
    if (!value) diagnostics.push(`FINAL_HANDOFF.validation.${field}_missing`);
    else if (!validationBoolOk(value)) diagnostics.push(`FINAL_HANDOFF.validation.${field}_invalid=${value}`);
  }
  const mechanicalCheck = firstField(fields, "mechanical_check");
  if (!mechanicalCheck) diagnostics.push("FINAL_HANDOFF.validation.mechanical_check_missing");
  else if (pyCasefold(pyStrip(mechanicalCheck)) !== "pass") {
    diagnostics.push(`FINAL_HANDOFF.validation.mechanical_check_not_pass=${mechanicalCheck}`);
  }
  const businessGate = taskBusinessGate(taskPackage);
  if (businessGate && !incompleteExit && !businessGateValue(handoff, fields, businessGate)) {
    if (businessGate.startsWith("FINAL_HANDOFF.output.")) issues.push(`${businessGate}_missing`);
    else issues.push(`FINAL_HANDOFF.output.${businessGate}_missing`);
  } else if (businessGate && !incompleteExit) {
    const gateValue = businessGateValue(handoff, fields, businessGate);
    const allowedGateValues = taskGateValues(taskPackage);
    if (allowedGateValues.length && gateValue && !allowedGateValues.includes(gateValue)) {
      const leaf = businessGate.slice(businessGate.lastIndexOf(".") + 1);
      issues.push(
        `FINAL_HANDOFF.output.${leaf}_invalid=${gateValue}; expected one of ${[...allowedGateValues].sort(comparePythonStrings).join(" | ")}`
      );
    }
    issues.push(...validateCapabilityBusinessGate(taskPackage, handoff, fields, businessGate));
  }
  const expectedTargetRepo = taskTargetRepo(taskPackage);
  if (expectedTargetRepo && !needsOwnerExit) {
    const outputTargetRepo = firstField(fields, "target_repo");
    if (!outputTargetRepo) issues.push("FINAL_HANDOFF.output.target_repo_missing");
    else if (!sameResolvedPath(outputTargetRepo, expectedTargetRepo)) issues.push("FINAL_HANDOFF.output.target_repo_mismatch");
  }
  const expectedResolvedFile = taskExpectedResolvedFile(taskPackage);
  if (expectedResolvedFile && !needsOwnerExit) {
    const outputResolvedFile = firstField(fields, "resolved_file_path");
    const outputFile = firstField(fields, "file_path");
    if (!outputResolvedFile) issues.push("FINAL_HANDOFF.output.resolved_file_path_missing");
    else if (!sameResolvedPath(outputResolvedFile, expectedResolvedFile)) issues.push("FINAL_HANDOFF.output.resolved_file_path_mismatch");
    if (outputFile && !sameResolvedPath(outputFile, expectedResolvedFile)) {
      issues.push("FINAL_HANDOFF.output.file_path_not_expected_output");
    }
  }
  const handoffResolvedFile = taskHandoffResolvedFile(taskPackage);
  if (handoffResolvedFile) {
    const outputResolvedHandoff = firstField(fields, "resolved_handoff_file");
    const outputHandoff = firstField(fields, "handoff_file");
    if (!outputResolvedHandoff) issues.push("FINAL_HANDOFF.output.resolved_handoff_file_missing");
    else if (!sameResolvedPath(outputResolvedHandoff, handoffResolvedFile)) issues.push("FINAL_HANDOFF.output.resolved_handoff_file_mismatch");
    if (outputHandoff && !sameResolvedPath(outputHandoff, handoffResolvedFile)) {
      issues.push("FINAL_HANDOFF.output.handoff_file_not_expected_handoff");
    }
    if (actualHandoffPath !== null && actualHandoffPath !== void 0 && !pySamePath(resolveLikePython(actualHandoffPath), resolveLikePython(handoffResolvedFile))) {
      issues.push("handoff_file_actual_path_mismatch");
    }
  }
  const refs = [];
  const expectedFile = taskExpectedOutputFile(taskPackage);
  if (expectedFile && !needsOwnerExit) refs.push(expectedFile);
  for (const field of ["file_path", "handoff_file", "report_ref", "output_ref"]) {
    const value = firstField(fields, field);
    if (value) refs.push(value);
  }
  refs.push(...sectionItems(handoff, "evidence_refs"));
  refs.push(...sectionItems(handoff, "evidence"));
  const missing = missingPaths(refs, taskPackage);
  for (const item of missing) issues.push(`referenced_path_missing=${item}`);
  let missingSections = [];
  if (expectedFile && !incompleteExit && !missing.includes(expectedFile)) {
    missingSections = missingRequiredSections(expectedFile, taskRequiredSections(taskPackage), taskPackage);
    for (const section of missingSections) diagnostics.push(`expected_output.required_section_missing=${section}`);
  }
  const status = issues.length ? "fail" : "pass";
  return {
    tool: "subagent_handoff_check",
    status,
    exit_code: status === "pass" ? 0 : 1,
    package_id: handoffPackageId || taskPackageId,
    handoff_fields_ok: !issues.some((issue) => issue.startsWith("FINAL_HANDOFF.")),
    business_gate_ok: !issues.some((issue) => issue.startsWith("FINAL_HANDOFF.output.") && issue.endsWith("_missing")),
    expected_output_present: !(expectedFile && missing.includes(expectedFile)),
    required_sections_ok: !missingSections.length,
    missing_required_sections: missingSections,
    references_exist: !missing.length,
    mechanical_check: status === "pass" ? "pass" : "fail",
    diagnostics,
    issues
  };
}
function buildText(data) {
  const lines = [
    "SUBAGENT_HANDOFF_CHECK:",
    `  status: ${data.status}`,
    `  package_id: ${pyGet(data, "package_id") ?? ""}`,
    `  mechanical_check: ${data.mechanical_check}`,
    `  handoff_fields_ok: ${String(data.handoff_fields_ok).toLowerCase()}`,
    `  business_gate_ok: ${String(pyGet(data, "business_gate_ok") ?? true).toLowerCase()}`,
    `  expected_output_present: ${String(data.expected_output_present).toLowerCase()}`,
    `  required_sections_ok: ${String(pyGet(data, "required_sections_ok") ?? true).toLowerCase()}`,
    `  references_exist: ${String(data.references_exist).toLowerCase()}`
  ];
  if (data.issues && data.issues.length) {
    lines.push("  issues:");
    for (const issue of data.issues) lines.push(`    - ${issue}`);
  }
  if (data.diagnostics?.length) {
    lines.push("  diagnostics:");
    for (const diagnostic of data.diagnostics) lines.push(`    - ${diagnostic}`);
  }
  return `${lines.join("\n")}
`;
}
function runSelfTest() {
  const tempRoot = path4.join(ROOT, "tmp", `subagent-handoff-check-self-test-${Math.trunc(clock.now().getTime())}`);
  try {
    mkdirSync2(tempRoot, { recursive: true });
    const report = path4.join(tempRoot, "report.md");
    const handoff = path4.join(tempRoot, "handoff.yaml");
    const packageFile = path4.join(tempRoot, "task-package.json");
    writeFileSync(report, "# report\n\n## scope\n\n## summary\n\n## findings\n\n## \u7ED3\u8BBA\u524D\u7F6E\n", "utf8");
    writeFileSync(
      packageFile,
      `${JSON.stringify({
        task_package: {
          package_id: "pkg-handoff-check-self-test",
          handoff_contract: { accept_verdicts: ["done", "partial", "needs_owner", "failed"] },
          expected_output: {
            mode: "file",
            file_path: rel(report),
            business_gate: "sample_gate",
            required_sections: ["scope", "summary", "findings", "\u7ED3\u8BBA\u524D\u7F6E"]
          }
        }
      })}
`,
      "utf8"
    );
    writeFileSync(
      handoff,
      [
        "FINAL_HANDOFF:",
        "  package_id: pkg-handoff-check-self-test",
        "  verdict: done",
        "  output:",
        `    file_path: ${rel(report)}`,
        `    handoff_file: ${rel(handoff)}`,
        "    sample_gate: pass",
        "  validation:",
        "    required_files_loaded: true",
        "    expected_output_satisfied: true",
        "    scope_compliant: true",
        "    mechanical_check: pass",
        "  evidence_refs:",
        `    - ${rel(report)}`,
        "  evidence:",
        "    - ENV|TEST_PATH=C:\\\\Program Files\\\\Example",
        "    - REG|Example Tool|loc=C:\\\\Program Files\\\\Example",
        ""
      ].join("\n"),
      "utf8"
    );
    const data = checkHandoff(loadJson2(packageFile), pyReadTextReplace(handoff));
    if (data.status !== "pass") throw new ToolError("self-test expected pass");
    const missingGate = pyReadTextReplace(handoff).replace("    sample_gate: pass\n", "");
    const failedGate = checkHandoff(loadJson2(packageFile), missingGate);
    if (failedGate.status !== "fail" || !failedGate.issues.some((issue) => issue.includes("sample_gate_missing"))) {
      throw new ToolError("self-test expected missing business gate failure");
    }
    writeFileSync(report, "# report\n\n## scope\n\n## findings\n\n## \u7ED3\u8BBA\u524D\u7F6E\n", "utf8");
    const failedSections = checkHandoff(loadJson2(packageFile), pyReadTextReplace(handoff));
    if (failedSections.status !== "pass" || failedSections.required_sections_ok || !failedSections.diagnostics.length) {
      throw new ToolError("self-test expected missing section diagnostics without rejection");
    }
    unlinkSync2(report);
    const needsOwnerHandoff = [
      "FINAL_HANDOFF:",
      "  package_id: pkg-handoff-check-self-test",
      "  verdict: needs_owner",
      "  output:",
      "    file_path: null",
      `    handoff_file: ${rel(handoff)}`,
      "  validation:",
      "    required_files_loaded: true",
      "    expected_output_satisfied: false",
      "    scope_compliant: true",
      "    mechanical_check: pass",
      "  evidence_refs: []",
      ""
    ].join("\n");
    const needsOwnerData = checkHandoff(loadJson2(packageFile), needsOwnerHandoff);
    if (needsOwnerData.status !== "pass") {
      throw new ToolError("self-test expected needs_owner without expected output file to pass");
    }
    writeFileSync(report, "# report\n\n## scope\n\n## summary\n\n## findings\n\n## \u7ED3\u8BBA\u524D\u7F6E\n", "utf8");
    const broken = pyReadTextReplace(handoff).replace(rel(report), "tmp/missing-report.md");
    const failed = checkHandoff(loadJson2(packageFile), broken);
    if (failed.status !== "fail" || !failed.issues.length) throw new ToolError("self-test expected missing path failure");
    const taggedMissing = pyReadTextReplace(handoff).split(`    - ${rel(report)}`).join("    - FILE|tmp/missing-report.md");
    const failedTagged = checkHandoff(loadJson2(packageFile), taggedMissing);
    if (failedTagged.status !== "fail" || !failedTagged.issues.some((issue) => issue.includes("referenced_path_missing=FILE|tmp/missing-report.md"))) {
      throw new ToolError("self-test expected generic tagged missing path failure");
    }
    const invalidVerdict = pyReadTextReplace(handoff).split("  verdict: done").join("  verdict: surprise");
    const failedVerdict = checkHandoff(loadJson2(packageFile), invalidVerdict);
    if (failedVerdict.status !== "fail" || !failedVerdict.issues.some((issue) => issue.includes("verdict_invalid=surprise"))) {
      throw new ToolError("self-test expected invalid verdict failure");
    }
    const invalidValidation = pyReadTextReplace(handoff).split("    required_files_loaded: true").join("    required_files_loaded: maybe");
    const failedValidation = checkHandoff(loadJson2(packageFile), invalidValidation);
    if (failedValidation.status !== "pass" || !failedValidation.diagnostics.length) {
      throw new ToolError("self-test expected invalid self-report diagnostics without rejection");
    }
    const missingMechanical = pyReadTextReplace(handoff).replace("    mechanical_check: pass\n", "");
    const failedMechanical = checkHandoff(loadJson2(packageFile), missingMechanical);
    if (failedMechanical.status !== "pass" || !failedMechanical.diagnostics.length) {
      throw new ToolError("self-test expected missing self-report diagnostics without rejection");
    }
    const synonymHandoff = pyReadTextReplace(handoff).split("  verdict: done").join("  verdict: completed");
    const synonymFailed = checkHandoff(loadJson2(packageFile), synonymHandoff);
    if (synonymFailed.status !== "fail" || !synonymFailed.issues.includes("FINAL_HANDOFF.verdict_invalid=completed")) {
      throw new ToolError("self-test expected verdict completed to fail against accept_verdicts [done, ...]");
    }
    const nestedDecoy = pyReadTextReplace(handoff).split("    sample_gate: pass").join("    meta:\n      sample_gate: pass");
    const failedNestedDecoy = checkHandoff(loadJson2(packageFile), nestedDecoy);
    if (failedNestedDecoy.status !== "fail" || !failedNestedDecoy.issues.some((issue) => issue.includes("FINAL_HANDOFF.output.sample_gate_missing"))) {
      throw new ToolError("self-test expected nested output.meta.sample_gate not to satisfy the business gate");
    }
    const directWithDecoy = pyReadTextReplace(handoff).split("    sample_gate: pass").join("    meta:\n      sample_gate: decoy\n    sample_gate: pass");
    if (businessGateValue(extractFinalHandoff(directWithDecoy), null, "sample_gate") !== "pass" || checkHandoff(loadJson2(packageFile), directWithDecoy).status !== "pass") {
      throw new ToolError("self-test expected direct output.sample_gate to be read past a nested decoy");
    }
    const labeledHandoff = pyReadTextReplace(handoff).split(`    - ${rel(report)}`).join(`    - location: ${rel(report)}:12-34`);
    const labeledOk = checkHandoff(loadJson2(packageFile), labeledHandoff);
    if (labeledOk.issues.some((issue) => issue.includes("referenced_path_missing"))) {
      throw new ToolError("self-test expected labeled line-suffixed existing path to resolve");
    }
    const labeledMissing = pyReadTextReplace(handoff).split(`    - ${rel(report)}`).join("    - location: tmp/missing-labeled.md");
    const failedLabeled = checkHandoff(loadJson2(packageFile), labeledMissing);
    if (!failedLabeled.issues.some((issue) => issue.includes("referenced_path_missing=tmp/missing-labeled.md"))) {
      throw new ToolError("self-test expected labeled missing path to still fail");
    }
    const planReviewPackage = {
      package_id: "pkg-handoff-check-plan-review-self-test",
      agent: { role: "plan-checker", capability: { name: "plan-review" } },
      handoff_contract: { accept_verdicts: ["pass", "partial", "fail", "needs_owner", "failed"] },
      expected_output: {
        mode: "file",
        file_path: rel(report),
        business_gate: "FINAL_HANDOFF.output.overall",
        required_sections: ["scope", "summary", "findings", "\u7ED3\u8BBA\u524D\u7F6E"]
      }
    };
    let planReviewHandoff = pyReadTextReplace(handoff).split("    sample_gate: pass").join("    overall: APPROVED");
    planReviewHandoff = planReviewHandoff.split("  package_id: pkg-handoff-check-self-test").join("  package_id: pkg-handoff-check-plan-review-self-test");
    planReviewHandoff = planReviewHandoff.split("  verdict: done").join("  verdict: pass");
    const planReviewOk = checkHandoff(planReviewPackage, planReviewHandoff);
    if (planReviewOk.status !== "pass") throw new ToolError("self-test expected plan-review APPROVED overall to pass");
    const planReviewBad = planReviewHandoff.split("    overall: APPROVED").join("    overall: pass");
    const failedPlanReview = checkHandoff(planReviewPackage, planReviewBad);
    if (failedPlanReview.status !== "fail" || !failedPlanReview.issues.some((issue) => issue.includes("overall_invalid=pass"))) {
      throw new ToolError("self-test expected plan-review invalid overall enum failure");
    }
    const prefixedDecoy = `example:
  output:
    overall: APPROVED

${planReviewHandoff.split("    overall: APPROVED\n").join("")}`;
    const failedDecoy = checkHandoff(planReviewPackage, prefixedDecoy);
    if (failedDecoy.status !== "fail" || !failedDecoy.issues.some((issue) => issue.includes("FINAL_HANDOFF.output.overall_missing"))) {
      throw new ToolError("self-test expected prefixed decoy output overall not to satisfy FINAL_HANDOFF output");
    }
    const externalRoot = path4.join(tempRoot, "external-target");
    mkdirSync2(externalRoot, { recursive: true });
    const externalReport = path4.join(externalRoot, "notes", "explorer", "external.md");
    const externalHandoff = path4.join(externalRoot, "notes", "handoffs", "external.yaml");
    const externalEvidence = path4.join(externalRoot, "outputs", "evidence", "target.json");
    const parentReport = path4.join(tempRoot, "notes", "explorer", "external.md");
    const parentHandoff = path4.join(tempRoot, "notes", "handoffs", "external.yaml");
    mkdirSync2(path4.dirname(externalReport), { recursive: true });
    mkdirSync2(path4.dirname(externalHandoff), { recursive: true });
    mkdirSync2(path4.dirname(externalEvidence), { recursive: true });
    mkdirSync2(path4.dirname(parentReport), { recursive: true });
    mkdirSync2(path4.dirname(parentHandoff), { recursive: true });
    writeFileSync(externalReport, "# report\n\n## scope\n\n## summary\n", "utf8");
    writeFileSync(externalEvidence, "{}\n", "utf8");
    writeFileSync(parentReport, "# report\n\n## scope\n\n## summary\n", "utf8");
    const externalPackage = {
      package_id: "pkg-handoff-check-target-repo",
      runtime_context: { target_repo: externalRoot },
      expected_output: {
        mode: "file",
        file_path: rel(parentReport),
        resolved_file_path: parentReport,
        business_gate: "sample_gate",
        required_sections: ["scope", "summary"]
      },
      handoff_contract: {
        accept_verdicts: ["done", "partial", "needs_owner", "failed"],
        handoff_file_required: true,
        handoff_file: rel(parentHandoff),
        resolved_handoff_file: parentHandoff
      }
    };
    writeFileSync(
      parentHandoff,
      [
        "FINAL_HANDOFF:",
        "  package_id: pkg-handoff-check-target-repo",
        "  verdict: done",
        "  output:",
        `    target_repo: ${externalRoot}`,
        `    file_path: ${rel(parentReport)}`,
        `    resolved_file_path: ${parentReport}`,
        `    handoff_file: ${rel(parentHandoff)}`,
        `    resolved_handoff_file: ${parentHandoff}`,
        "    sample_gate: pass",
        "  validation:",
        "    required_files_loaded: true",
        "    expected_output_satisfied: true",
        "    scope_compliant: true",
        "    mechanical_check: pass",
        "  evidence_refs:",
        `    - ${rel(parentReport)}`,
        "    - outputs/evidence/target.json",
        ""
      ].join("\n"),
      "utf8"
    );
    const externalData = checkHandoff(externalPackage, pyReadTextReplace(parentHandoff), { actualHandoffPath: parentHandoff });
    if (externalData.status !== "pass") {
      throw new ToolError("self-test expected parent-root cross-repo handoff check to pass");
    }
    writeFileSync(
      externalHandoff,
      pyReadTextReplace(parentHandoff).split(parentReport).join(externalReport).split(parentHandoff).join(externalHandoff).split(rel(parentReport)).join("notes/explorer/external.md").split(rel(parentHandoff)).join("notes/handoffs/external.yaml"),
      "utf8"
    );
    const externalBad = checkHandoff(externalPackage, pyReadTextReplace(externalHandoff), { actualHandoffPath: externalHandoff });
    if (externalBad.status !== "fail" || !externalBad.issues.some((issue) => issue.includes("resolved_file_path_mismatch") || issue.includes("actual_path_mismatch"))) {
      throw new ToolError("self-test expected external handoff output path to fail");
    }
    let relativeTargetFailed = false;
    try {
      targetRoot({ runtime_context: { target_repo: "relative-target" } });
    } catch (error) {
      if (!String(error?.message ?? "").includes("must be an absolute path")) throw error;
      relativeTargetFailed = true;
    }
    if (!relativeTargetFailed) throw new ToolError("self-test expected relative target_repo to fail");
    let missingTargetFailed = false;
    try {
      targetRoot({ runtime_context: { target_repo: path4.join(tempRoot, "missing-target") } });
    } catch (error) {
      if (!String(error?.message ?? "").includes("runtime_context.target_repo not found")) throw error;
      missingTargetFailed = true;
    }
    if (!missingTargetFailed) throw new ToolError("self-test expected missing target_repo to fail");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  process4.stdout.write("PASS subagent_handoff_check self-test\n");
  return 0;
}
var NON_PATH_EVIDENCE_LABELS;
var init_subagent_handoff_check = __esm({
  "ops/tools/dispatch-core/subagent_handoff_check.mjs"() {
    init_tool_common();
    init_py();
    NON_PATH_EVIDENCE_LABELS = /* @__PURE__ */ new Set([
      "ENV",
      "REG",
      "CMD",
      "DIR",
      "DIR1",
      "DIR2",
      "DIR3",
      "SERVICE",
      "PROCESS",
      "PORT",
      "LICENSE"
    ]);
  }
});

// ops/tools/subagent_handoff_check.mjs
import process5 from "node:process";
var checkerSpec = process5.env.PI_TASK_RESULT_HANDOFF_CHECK ? JSON.parse(process5.env.PI_TASK_RESULT_HANDOFF_CHECK) : null;
var packageFlag = checkerSpec?.argv?.indexOf("--task-package") ?? -1;
if (packageFlag >= 0 && process5.argv.includes(checkerSpec.argv[packageFlag + 1]) && checkerSpec.env?.SUBAGENT_PROJECT_ROOT) {
  process5.env.SUBAGENT_PROJECT_ROOT = checkerSpec.env.SUBAGENT_PROJECT_ROOT;
}
var { ToolError: ToolError2, emit: emit2, readStdinText: readStdinText2, repoPath: repoPath2 } = await Promise.resolve().then(() => (init_tool_common(), tool_common_exports));
var { pyReadTextReplace: pyReadTextReplace2 } = await Promise.resolve().then(() => (init_py(), py_exports));
var {
  buildText: buildText2,
  checkHandoff: checkHandoff2,
  loadJson: loadJson3,
  loadTaskPackageById: loadTaskPackageById2,
  runSelfTest: runSelfTest2,
  taskPath: taskPath2
} = await Promise.resolve().then(() => (init_subagent_handoff_check(), subagent_handoff_check_exports));
var PROGRAM = "subagent_handoff_check.mjs";
var USAGE = `usage: ${PROGRAM} [-h] [--task-package TASK_PACKAGE] [--package-id PACKAGE_ID] [--handoff-file HANDOFF_FILE] [--handoff-stdin] [--format {text,json}] [--self-test]`;
var DESCRIPTION = "\u5B50\u4EE3\u7406\u9000\u51FA\u524D\u673A\u68B0\u81EA\u68C0 FINAL_HANDOFF \u7684\u7ED3\u6784\u5B8C\u6574\u6027\u3001\u6807\u8BC6\u4E00\u81F4\u6027\u548C\u5F15\u7528\u8DEF\u5F84\u6709\u6548\u6027\u3002\u5B50\u4EE3\u7406\u5728\u8F93\u51FA FINAL_HANDOFF \u4E4B\u524D\u8C03\u7528\u6B64\u5DE5\u5177\uFF0C\u53D6\u5F97 mechanical_check=pass \u540E\u624D\u80FD\u9000\u51FA\uFF1B\u4E3B\u4EE3\u7406\u4E5F\u53EF\u7528\u6B64\u5DE5\u5177\u9A8C\u6536\u5B50\u4EE3\u7406\u56DE\u6267\u3002";
var EPILOG = `\u5178\u578B\u7528\u6CD5\uFF1Anode ops/tools/${PROGRAM} --package-id <id> --handoff-stdin < handoff.yaml
\u4F7F\u7528\u65F6\u673A\u4E0E\u8FB9\u754C\u89C1 ops/policies/runtime-tools.md`;
var OPTIONS = [
  { flag: "--task-package", dest: "taskPackage", kind: "value", metavar: "TASK_PACKAGE", help: "\u4EFB\u52A1\u5305 JSON \u6587\u4EF6\u8DEF\u5F84\uFF08\u542B task_package \u5305\u88C5\u6216\u88F8 task_package \u5BF9\u8C61\u5747\u53EF\uFF09\uFF1B\u4E0E --package-id \u4E8C\u9009\u4E00\u63D0\u4F9B\u3002" },
  { flag: "--package-id", dest: "packageId", kind: "value", metavar: "PACKAGE_ID", help: "\u901A\u8FC7 package_id \u81EA\u52A8\u5728 tmp/dispatch_prepare/\uFF08\u542B preparations/prep-*/package.json\uFF09\u548C notes/manifests/ \u4E2D\u67E5\u627E\u4EFB\u52A1\u5305\u6587\u4EF6\uFF1B\u4E0E --task-package \u4E8C\u9009\u4E00\u63D0\u4F9B\u3002" },
  { flag: "--handoff-file", dest: "handoffFile", kind: "value", metavar: "HANDOFF_FILE", help: "\u5305\u542B FINAL_HANDOFF \u5185\u5BB9\u7684\u6587\u4EF6\u8DEF\u5F84\uFF1B\u4E0E --handoff-stdin \u4E8C\u9009\u4E00\u63D0\u4F9B\u3002" },
  { flag: "--handoff-stdin", dest: "handoffStdin", kind: "flag", help: "\u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u53D6 FINAL_HANDOFF \u6587\u672C\uFF1B\u4E0E --handoff-file \u4E8C\u9009\u4E00\u63D0\u4F9B\u3002" },
  { flag: "--format", dest: "format", kind: "value", metavar: "{text,json}", choices: ["text", "json"], help: "\u8F93\u51FA\u683C\u5F0F\uFF1Atext \u8F93\u51FA\u4EBA\u7C7B\u53EF\u8BFB\u68C0\u67E5\u6458\u8981\uFF0Cjson \u8F93\u51FA\u673A\u5668\u53EF\u8BFB\u5B8C\u6574\u68C0\u67E5\u7ED3\u679C\u3002" },
  { flag: "--self-test", dest: "selfTest", kind: "flag", help: "\u8FD0\u884C\u5185\u90E8\u5192\u70DF\u6D4B\u8BD5\u5E76\u62A5\u544A\u7ED3\u679C\u3002" }
];
var ArgumentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
};
var HelpRequested = class extends Error {
};
function helpText() {
  const lines = [USAGE, "", DESCRIPTION, "", "options:", "  -h, --help            show this help message and exit"];
  for (const option of OPTIONS) {
    const invocation = option.kind === "value" ? `${option.flag} ${option.metavar}` : option.flag;
    lines.push(`  ${invocation}`);
    lines.push(`      ${option.help}`);
  }
  lines.push("", EPILOG);
  return `${lines.join("\n")}
`;
}
function matchOption(token) {
  const exact = OPTIONS.find((option) => option.flag === token);
  if (exact) return exact;
  const prefixed = OPTIONS.filter((option) => option.flag.startsWith(token));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new ArgumentError(`ambiguous option: ${token} could match ${prefixed.map((option) => option.flag).join(", ")}`);
  }
  return null;
}
function parseArgs(argv) {
  const args = {
    taskPackage: null,
    packageId: null,
    handoffFile: null,
    handoffStdin: false,
    format: "text",
    selfTest: false
  };
  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") throw new HelpRequested();
    if (!token.startsWith("--")) throw new ArgumentError(`unrecognized arguments: ${token}`);
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : null;
    const option = matchOption(name);
    if (!option) throw new ArgumentError(`unrecognized arguments: ${token}`);
    if (option.kind === "flag") {
      if (inline !== null) throw new ArgumentError(`argument ${option.flag}: ignored explicit argument '${inline}'`);
      args[option.dest] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      if (!tokens.length) throw new ArgumentError(`argument ${option.flag}: expected one argument`);
      value = tokens.shift();
    }
    if (option.choices && !option.choices.includes(value)) {
      throw new ArgumentError(
        `argument ${option.flag}: invalid choice: '${value}' (choose from ${option.choices.map((item) => `'${item}'`).join(", ")})`
      );
    }
    args[option.dest] = value;
  }
  return args;
}
function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) return runSelfTest2();
  if (Boolean(args.taskPackage) === Boolean(args.packageId)) {
    throw new ToolError2("provide exactly one of --task-package or --package-id");
  }
  if (Boolean(args.handoffFile) === Boolean(args.handoffStdin)) {
    throw new ToolError2("provide exactly one of --handoff-file or --handoff-stdin");
  }
  let taskPackage;
  if (args.packageId) {
    [, taskPackage] = loadTaskPackageById2(args.packageId);
  } else {
    taskPackage = loadJson3(repoPath2(args.taskPackage, "task_package", { mustExist: true }));
  }
  let handoffText;
  let actualHandoffPath;
  if (args.handoffStdin) {
    handoffText = readStdinText2("handoff").replace(/\r\n|\r/g, "\n");
    actualHandoffPath = null;
  } else {
    actualHandoffPath = taskPath2(args.handoffFile, taskPackage, { label: "handoff_file", mustExist: true });
    handoffText = pyReadTextReplace2(actualHandoffPath);
  }
  const data = checkHandoff2(taskPackage, handoffText, { actualHandoffPath });
  return emit2(data, args.format, buildText2(data));
}
try {
  process5.exitCode = main(process5.argv.slice(2));
} catch (error) {
  if (error instanceof HelpRequested) {
    process5.stdout.write(helpText());
    process5.exitCode = 0;
  } else if (error instanceof ArgumentError) {
    process5.stderr.write(`${USAGE}
${PROGRAM}: error: ${error.message}
`);
    process5.exitCode = 2;
  } else if (error instanceof ToolError2 || error?.name === "ToolError") {
    process5.stderr.write(`error: ${error.message}
`);
    process5.exitCode = 1;
  } else {
    throw error;
  }
}
export {
  main,
  parseArgs
};
