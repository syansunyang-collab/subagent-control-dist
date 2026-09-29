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
import { spawnSync } from "node:child_process";
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
function runGit(args) {
  const cmd = ["git", ...args.map(String)];
  const proc = spawnSync("git", args.map(String), { cwd: ROOT, encoding: "utf8", windowsHide: true });
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
function isSameOrInside(candidate, root) {
  if (!candidate || !root) return false;
  const target = resolveLikePython(candidate);
  const base = resolveLikePython(root);
  const relative = path2.relative(base, target);
  return relative === "" || !relative.startsWith("..") && !path2.isAbsolute(relative);
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
import { spawnSync as spawnSync2 } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
import path3 from "node:path";
import process4 from "node:process";
function pyStrip(value) {
  return String(value ?? "").replace(RE_LSTRIP, "").replace(RE_RSTRIP, "");
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
function pyRelativeTo(child, parent) {
  return pyIsRelativeTo(child, parent) ? pyRelativeToPosix(child, parent) : null;
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
    return spawnSync2(line, [], { ...options, shell: true });
  }
  return spawnSync2(cmd, args, options);
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

// ops/tools/dispatch-core/model_catalog_cache.mjs
import { mkdirSync as mkdirSync2, readFileSync as readFileSync4, renameSync as renameSync2, rmSync, statSync as statSync3, writeFileSync } from "node:fs";
import { createHash as createHash2, randomBytes } from "node:crypto";
import path4 from "node:path";
function canonicalJson2(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}
function catalogCacheKey(identity) {
  return createHash2("sha256").update(canonicalJson2(identity), "utf8").digest("hex");
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
    text3 = readFileSync4(cacheFile, "utf8");
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
    mkdirSync2(path4.dirname(cacheFile), { recursive: true });
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
import { createHash as createHash3 } from "node:crypto";
import { closeSync as closeSync2, mkdirSync as mkdirSync3, openSync as openSync2, readdirSync, readFileSync as readFileSync5, renameSync as renameSync3, rmSync as rmSync2, statSync as statSync4, writeFileSync as writeFileSync2, writeSync as writeSync2 } from "node:fs";
import net from "node:net";
import path5 from "node:path";
import { homedir } from "node:os";
import process5 from "node:process";
import { spawn as spawnChild, spawnSync as spawnSync3 } from "node:child_process";
function releasedPanelAssetRoot() {
  try {
    return JSON.parse(readFileSync5(path5.join(PANEL_STATE_ROOT, "runtime-root.json"), "utf8")).root;
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
  const deps3 = {
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
  deps3.isOurPanel ??= (payload, endpoint) => isOurPanel(payload, endpoint);
  deps3.allocateEndpoint ??= () => allocateEndpoint({ deps: deps3 });
  deps3.rememberProject ??= () => rememberProject({ deps: deps3 });
  deps3.validManifest ??= () => validManifest({ deps: deps3 });
  deps3.runningShell ??= () => runningShell({ deps: deps3 });
  deps3.buildRunning ??= () => buildRunning({ deps: deps3 });
  deps3.acquireBuildLock ??= () => acquireBuildLock({ deps: deps3 });
  deps3.startShell ??= (executable, endpoint) => startShell(executable, endpoint, { deps: deps3 });
  deps3.startBackgroundBuild ??= () => startBackgroundBuild({ deps: deps3 });
  return deps3;
}
function spawnDetached(argv, { cwd, env } = {}) {
  const child = spawnChild(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: "ignore",
    detached: true,
    windowsHide: true
  });
  child.unref();
  return { pid: child.pid };
}
function runCapture(argv, { cwd } = {}) {
  const proc = spawnSync3(argv[0], argv.slice(1), {
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
    const value = JSON.parse(readFileSync5(file, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
function writeJson(file, value) {
  mkdirSync3(path5.dirname(file), { recursive: true });
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
  const panelDigest = createHash3("sha256").update(normalizeIdentityPath(panelRoot), "utf8").digest();
  const port = PORT_BASE + panelDigest.readUInt16BE(0) % PORT_SPAN;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    panel_root: normalizeIdentityPath(panelRoot),
    control_root: normalizeIdentityPath(controlRoot)
  };
}
function rememberProject({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
  const root = resolveLikePython(resolved.paths.controlRoot);
  const key = createHash3("sha256").update(normalizeIdentityPath(root)).digest("hex");
  resolved.writeJson(path5.join(resolved.paths.runtimeRoot, "projects", `${key}.json`), { project_root: root });
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
async function allocateEndpoint({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
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
function runningShell({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
  const state = resolved.readJson(resolved.paths.shellStatePath);
  return state?.running === true && resolved.isProcessAlive(state.pid) ? state : {};
}
function buildRunning({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
  const state = resolved.readJson(resolved.paths.buildStatePath);
  return state?.status === "running" && resolved.isProcessAlive(state.pid);
}
function runtimeBuildId({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
  return resolved.readJson(path5.join(resolved.paths.assetRoot, "ops", "dist", "subagent_service.manifest.json")).build_id ?? null;
}
function validManifest({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
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
function startShell(executable, endpoint, { deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
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
    launchOptions(resolved)
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
function startBackgroundBuild({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
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
async function ensureAgentPanel({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
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
function acquireBuildLock({ deps: deps3 } = {}) {
  const resolved = resolveDeps(deps3);
  mkdirSync3(resolved.paths.runtimeRoot, { recursive: true });
  try {
    return openSync2(resolved.paths.buildLockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    const stale = Date.now() / 1e3 - statSync4(resolved.paths.buildLockPath).mtimeMs / 1e3;
    if (stale > STILL_ACTIVE_LOCK_STALE_SECONDS && !resolved.buildRunning()) {
      rmSync2(resolved.paths.buildLockPath, { force: true });
      return openSync2(resolved.paths.buildLockPath, "wx");
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
    MONITOR_ROOT = path5.resolve(process5.env.SUBAGENT_PROJECT_ROOT || process5.cwd());
    PANEL_STATE_ROOT = path5.resolve(process5.env.AGENT_PANEL_STATE_ROOT || path5.join(homedir(), ".subagent-control", "agent-panel"));
    PANEL_ASSET_ROOT = path5.resolve(
      process5.env.AGENT_PANEL_RUNTIME_ROOT || releasedPanelAssetRoot() || path5.join(homedir(), ".pi", "agent", "extensions", "subagent-control")
    );
    PANEL_ROOT = path5.join(PANEL_ASSET_ROOT, "src", "agent-panel");
    SHELL_ROOT = path5.join(PANEL_ROOT, "shell");
    PROJECT_FILE = path5.join(SHELL_ROOT, "AgentPanel.Shell.csproj");
    RUNTIME_ROOT2 = PANEL_STATE_ROOT;
    ENDPOINT_PATH = path5.join(RUNTIME_ROOT2, "endpoint.json");
    MANIFEST_PATH = path5.join(RUNTIME_ROOT2, "build-manifest.json");
    BUILD_STATE_PATH = path5.join(RUNTIME_ROOT2, "build-state.json");
    BUILD_LOG_PATH = path5.join(RUNTIME_ROOT2, "last-build.log");
    BUILD_LOCK_PATH = path5.join(RUNTIME_ROOT2, "build.lock");
    SHELL_STATE_PATH = path5.join(RUNTIME_ROOT2, "shell-state.json");
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
      buildScript: path5.join(PANEL_ASSET_ROOT, "ops", "dist", "agent_panel_launcher.bundle.mjs")
    });
    STILL_ACTIVE_LOCK_STALE_SECONDS = 600;
  }
});

// ops/tools/dispatch-core/prepared_dispatch.mjs
import {
  closeSync as closeSync3,
  fstatSync as fstatSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync4,
  openSync as openSync3,
  readFileSync as readFileSync6,
  readdirSync as readdirSync2,
  rmSync as rmSync3,
  rmdirSync,
  statSync as statSync5,
  unlinkSync as unlinkSync2
} from "node:fs";
import path6 from "node:path";
function _relativeUnder(root, target) {
  const relative = path6.relative(root, target);
  if (!relative) return [];
  if (path6.isAbsolute(relative) || relative.split(/[\\/]/)[0] === "..") return null;
  return relative.split(/[\\/]+/).filter(Boolean);
}
function _parentsOf(target) {
  const parents = [];
  let current = path6.dirname(target);
  while (true) {
    parents.push(current);
    const next = path6.dirname(current);
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
function _reviewEvidenceContract(pkg) {
  if (!isRecord(pkg)) return [false, null];
  let value = pkg;
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
function validateAsyncDispatchV2(envelope, { package: pkg = null } = {}) {
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
  const runtimeRoot2 = path6.resolve(path6.join(producerRoot, ".runtime"));
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
  const [packageEvidenceOnly] = _reviewEvidenceContract(pkg);
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
    current = path6.join(current, part);
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
  const parent = path6.join(producer, "tmp", "dispatch_prepare", PREPARATION_DIRECTORY_NAME);
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
    const preparation = path6.join(parent, `${PREPARATION_PREFIX}${_preparationHex()}`);
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
function _packageId(pkg) {
  const value = Object.hasOwn(pkg, "task_package") ? pkg.task_package : pkg;
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
function _invokeBuilder(builder, materialRoot, pkg) {
  if (typeof builder !== "function") return builder(materialRoot, pkg);
  return builder.length >= 2 ? builder(materialRoot, pkg) : builder(materialRoot);
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
      path6.isAbsolute(value) ? value : path6.join(materialRoot, value),
      "callback output",
      { error: PreparedDispatchError }
    );
    _assertNoEscape(candidate, materialRoot, { allowMissingLeaf: false });
    const relative = path6.relative(materialRoot, candidate).replace(/\\/g, "/") || ".";
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
      entries = readdirSync2(directory);
    } catch (caught) {
      throw new PreparedDispatchError(`cannot inspect preparation output ${directory}: ${caught.message}`);
    }
    for (const name of entries) {
      const target = path6.join(directory, name);
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
    const target = path6.join(materialRoot, filename);
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
    if (RESERVED_FILENAMES.includes(path6.basename(target)) && pyNormcase(path6.dirname(target)) === pyNormcase(materialRoot)) {
      continue;
    }
    outputs.push(path6.relative(materialRoot, target).replace(/\\/g, "/"));
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
  if (!path6.isAbsolute(text3)) return parts(text3).join("/") || ".";
  const target = parts(text3);
  const base = parts(root);
  if (!base.every((part, index) => pyNormcase(part) === pyNormcase(target[index] ?? ""))) return null;
  return target.slice(base.length).join("/") || ".";
}
function compilePreparedDispatch(pkg, options = {}) {
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
  if (!isRecord(pkg)) throw new PreparedDispatchError("package must be a dictionary");
  if (_isNone(originId) || typeof originId !== "string") {
    throw new PreparedDispatchError("origin_id must be explicitly supplied as a string");
  }
  const logicalPackageId = _packageId(pkg);
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
      callbackResult = _invokeBuilder(reviewEvidenceBuilder, materialRoot, pkg);
    }
    _assertReservedFilesAbsent(materialRoot);
    if (!_isNone(postMaterialCallback)) {
      const postResult = _invokeBuilder(postMaterialCallback, materialRoot, pkg);
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
    const finalPackageId = _packageId(pkg);
    if (finalPackageId !== logicalPackageId) {
      throw new PreparedDispatchError("task_package.package_id changed during preparation");
    }
    const packageFile = path6.join(materialRoot, PACKAGE_FILENAME);
    const taskFile = path6.join(materialRoot, TASK_FILENAME);
    const dispatchFile = path6.join(materialRoot, DISPATCH_FILENAME);
    const descriptorFile = path6.join(materialRoot, DESCRIPTOR_FILENAME);
    const packageBytes = canonicalJsonBytes(pkg);
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
    if (!canonicalJsonBytes(pkg).equals(packageBytes)) {
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
      preparation_id: path6.basename(materialRoot),
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
  const runtimeRoot2 = path6.join(producer, ".runtime");
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
    fd = openSync3(file, "r");
    const info = fstatSync2(fd);
    if (!info.isFile()) throw new PreparedDispatchError(`${label} is not a regular file: ${file}`);
    return readFileSync6(fd);
  } catch (caught) {
    if (caught instanceof PreparedDispatchError) throw caught;
    throw new PreparedDispatchError(`cannot read ${label}: ${file}`);
  } finally {
    if (fd !== null) {
      try {
        closeSync3(fd);
      } catch {
      }
    }
  }
}
function _descriptorPath(value, label) {
  let target;
  if (typeof value === "string" && value.trim()) target = value;
  else throw new PreparedDispatchError(`descriptor.${label} must be a non-empty absolute path`);
  if (!path6.isAbsolute(target)) {
    throw new PreparedDispatchError(`descriptor.${label} must be a non-empty absolute path`);
  }
  return absolutePath(target, `descriptor.${label}`, { error: PreparedDispatchError });
}
function _pathEqual(left, right) {
  return pyNormcase(absolutePath(left, "path", { error: PreparedDispatchError })) === pyNormcase(absolutePath(right, "path", { error: PreparedDispatchError }));
}
function _validatePackageEvidencePath(pkg, { producerRoot, materialRoot, preparedOutputs }) {
  const [, evidenceRef] = _reviewEvidenceContract(pkg);
  if (evidenceRef === null) return;
  let evidencePath = String(evidenceRef.path);
  if (!path6.isAbsolute(evidencePath)) evidencePath = path6.join(producerRoot, evidencePath);
  evidencePath = absolutePath(evidencePath, "review evidence", { error: PreparedDispatchError });
  _assertNoEscape(evidencePath, materialRoot, { allowMissingLeaf: false });
  const evidenceRelative = path6.relative(materialRoot, evidencePath).replace(/\\/g, "/");
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
  const expectedRoot = path6.join(
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
  if (!_pathEqual(descriptorPath, path6.join(materialRoot, DESCRIPTOR_FILENAME))) {
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
    if (pyNormcase(path6.dirname(target2)) !== pyNormcase(materialRoot) || path6.basename(target2) !== filename) {
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
  let pkg;
  let envelope;
  try {
    pkg = JSON.parse(material.package.toString("utf8"));
    envelope = JSON.parse(material.dispatch.toString("utf8"));
  } catch {
    throw new PreparedDispatchError("package or dispatch material is not valid UTF-8 JSON");
  }
  if (!isRecord(pkg) || !isRecord(envelope)) {
    throw new PreparedDispatchError("package and dispatch material must be JSON objects");
  }
  envelope = validateAsyncDispatchV2(envelope, { package: pkg });
  const packageValue = Object.hasOwn(pkg, "task_package") ? pkg.task_package : pkg;
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
    const runtimeRoot2 = path6.join(producerRoot, ".runtime");
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
    const output = path6.isAbsolute(value) ? value : path6.join(materialRoot, value);
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
  _validatePackageEvidencePath(pkg, {
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
  const marker = path6.join(root, DESCRIPTOR_FILENAME);
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
  const descriptor = path6.join(root, DESCRIPTOR_FILENAME);
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
import { existsSync as existsSync3, readdirSync as readdirSync3, statSync as statSync6 } from "node:fs";
import path7 from "node:path";
function valueError(message) {
  return pyError("ValueError", message);
}
function relRoute(routeFile) {
  return path7.relative(ROOT, routeFile).replace(/\\/g, "/");
}
function routeIdFromAgent(role, capability) {
  return `${role}__${capability}`;
}
function blockScalar(text3, routeFile) {
  const match = AGENT_BLOCK_RE.exec(text3);
  if (!match) throw valueError(`${relRoute(routeFile)} missing yaml task_package_agent block`);
  return match[1];
}
function parseCard(text3, routeFile) {
  const match = CARD_RE.exec(text3);
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
      const target = path7.join(RUNTIME_ROOT, promptPath);
      if (!(existsSync3(target) && statSync6(target).isFile())) {
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
  const routeId2 = path7.basename(routeFile, ".md");
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
  if (!(existsSync3(ROUTE_DIR) && statSync6(ROUTE_DIR).isDirectory())) {
    throw valueError(`route directory not found: ${path7.relative(RUNTIME_ROOT, ROUTE_DIR).replace(/\\/g, "/")}`);
  }
  const profiles = {};
  const names = readdirMd(ROUTE_DIR).sort();
  for (const name of names) {
    const profile = routeProfile(path7.join(ROUTE_DIR, name));
    profiles[profile.route_id] = profile;
  }
  if (!Object.keys(profiles).length) throw valueError("no task package routes found");
  return profiles;
}
function readdirMd(dir) {
  return readdirSync3(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
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
function conditionalRequiredFiles(pkg, profile) {
  const expected = [...pyGetItem(pyGetItem(profile, "agent"), "required_files")];
  const extensions = isRecord(pyGet(pkg, "extensions")) ? pyGet(pkg, "extensions") : {};
  const contracts = isRecord(pyGet(extensions, "capability_contract")) ? pyGet(extensions, "capability_contract") : {};
  const hasAcceptanceContext = Object.values(contracts).some(
    (contract2) => isRecord(contract2) && Object.hasOwn(contract2, "acceptance_context") && isRecord(pyGet(contract2, "acceptance_context"))
  );
  if (hasAcceptanceContext) expected.push(ACCEPTANCE_LEAF_COMMON_FILE);
  const card = isRecord(pyGet(profile, "card")) ? pyGet(profile, "card") : {};
  const selector = pyGet(card, "required_files_by_contract");
  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  const contract = slot && isRecord(pyGet(contracts, slot)) ? pyGet(contracts, slot) : {};
  if (isRecord(selector)) {
    const selected = pyStr(pyOr(pyGet(contract, pyStr(pyOr(pyGet(selector, "path"), ""))), ""));
    const mapping = isRecord(pyGet(selector, "map")) ? pyGet(selector, "map") : {};
    const promptPath = pyGet(mapping, selected);
    if (typeof promptPath === "string" && promptPath) expected.push(promptPath);
  }
  return [...new Set(expected)];
}
var ROUTE_DIR, ACCEPTANCE_LEAF_COMMON_FILE, REQUIRED_TOP_LEVEL, SEED_BODY_REQUIRED, AGENT_BLOCK_RE, CARD_RE, PROFILE_CACHE;
var init_task_package_profiles = __esm({
  "ops/tools/dispatch-core/task_package_profiles.mjs"() {
    init_tool_common();
    init_py();
    ROUTE_DIR = path7.join(RUNTIME_ROOT, "ops", "protocols", "task-package-routes");
    ACCEPTANCE_LEAF_COMMON_FILE = "ops/agent-prompts/_acceptance-leaf-common.md";
    REQUIRED_TOP_LEVEL = [
      "version",
      "package_id",
      "agent",
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
    AGENT_BLOCK_RE = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
    CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;
    PROFILE_CACHE = /* @__PURE__ */ new Map();
  }
});

// ops/tools/dispatch-core/task_package_build.mjs
import { existsSync as existsSync4, mkdirSync as mkdirSync5, writeFileSync as writeFileSync3 } from "node:fs";
import path8 from "node:path";
function deepCopy(value) {
  return structuredClone(value);
}
function readProjectName() {
  const projectFile = path8.join(ROOT, "PROJECT.md");
  if (!existsSync4(projectFile)) return "<\u9879\u76EE\u540D>";
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
function parseSeed(raw) {
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`package_seed is not valid JSON: ${error.message}`);
  }
  if (!isRecord(data)) throw new ToolError("package_seed root must be a JSON object");
  return cleanJsonStrings(data);
}
function cleanJsonStrings(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8").toString("utf8");
  if (Array.isArray(value)) return value.map(cleanJsonStrings);
  if (isRecord(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[pyStr(cleanJsonStrings(key))] = cleanJsonStrings(item);
    return out;
  }
  return value;
}
function repoAbsPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${label} must be a non-empty string`);
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  if (pyRelativeTo(lexical, projectReal) === null) {
    throw new ToolError(`${label} must resolve under repository root: ${value}`);
  }
  const resolved = resolveLikePython(lexical);
  if (pyRelativeTo(resolved, projectReal) === null && !isSameOrInside(resolved, RUNTIME_ROOT)) {
    throw new ToolError(`${label} must resolve under repository root: ${value}`);
  }
  return resolved;
}
function targetRepoRoot(runtime) {
  const target = pyGet(runtime, "target_repo", null);
  if (target === null || target === void 0 || target === "") return null;
  if (typeof target !== "string" || !target.trim()) {
    throw new ToolError("runtime_context.target_repo must be a non-empty string when set");
  }
  if (!isAbsoluteLikePython(target)) throw new ToolError("runtime_context.target_repo must be an absolute path");
  return resolveLikePython(target);
}
function repoOrTargetAbsPath(value, runtime, label) {
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${label} must be a non-empty string`);
  const projectReal = resolveLikePython(ROOT);
  const lexical = lexicalAbsolute(pathlibJoin(ROOT, value));
  const resolved = resolveLikePython(lexical);
  const inProjectLexically = pyRelativeTo(lexical, projectReal) !== null;
  if (inProjectLexically && (pyRelativeTo(resolved, projectReal) !== null || isSameOrInside(resolved, RUNTIME_ROOT))) {
    return resolved;
  }
  const target = targetRepoRoot(runtime);
  if (target !== null && pyRelativeTo(resolved, target) !== null) return resolved;
  throw new ToolError(`${label} must resolve under repository root or runtime_context.target_repo: ${value}`);
}
function requireDict(data, key) {
  const value = pyGet(data, key);
  if (!isRecord(value)) throw new ToolError(`${key} must be a JSON object`);
  return deepCopy(value);
}
function requireList(data, key) {
  const value = pyGet(data, key);
  if (!Array.isArray(value)) throw new ToolError(`${key} must be a JSON list`);
  return deepCopy(value);
}
function requireString(data, key) {
  const value = pyGet(data, key);
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${key} must be a non-empty string`);
  return value;
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
function scopeFromSeed(seed) {
  const scope = requireDict(seed, "scope");
  return {
    read: stringList(pyGet(scope, "read"), "scope.read"),
    write: stringList(pyGet(scope, "write"), "scope.write"),
    delete: stringList(pyGet(scope, "delete"), "scope.delete"),
    out_of_scope: stringList(pyGet(scope, "out_of_scope"), "scope.out_of_scope")
  };
}
function gitValue(args, fallback = "") {
  const result = runGit(args);
  if (result.exit_code !== 0) return fallback;
  return result.stdout.trim() || fallback;
}
function packageId(routeId2, seed) {
  if (pyTruthy(pyGet(seed, "package_id"))) return pyStr(pyGetItem(seed, "package_id"));
  const now = clock.now();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${utcDateStamp()}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `pkg-${String(routeId2).replaceAll("__", "-")}-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}
function routeIdFromSeed(seed) {
  const value = pyGet(seed, "route_id");
  if (typeof value === "string" && value.trim()) return value.trim();
  const inputs = pyGet(seed, "inputs");
  if (isRecord(inputs) && typeof pyGet(inputs, "route_id") === "string" && pyGetItem(inputs, "route_id").trim()) {
    throw new ToolError(
      "package_seed.route_id is required at the JSON root; inputs.route_id is task input metadata and is not used to select a route"
    );
  }
  throw new ToolError("package_seed.route_id is required at the JSON root");
}
function truthyText(value) {
  const base = pyTruthy(value) ? value : "";
  return TRUTHY_TEXT.has(pyStrip(pyStr(base)).toLowerCase());
}
function projectDeclarations(input) {
  const seed = deepCopy(input);
  for (const [object, canonical, legacy] of [
    [seed.expected_output, "file_path", "path"],
    [seed.handoff_contract, "require_final_handoff", "final_response_required"]
  ]) {
    if (!Object.hasOwn(object, canonical) && Object.hasOwn(object, legacy)) object[canonical] = object[legacy];
    delete object[legacy];
  }
  const destinations = [seed.expected_output.file_path, seed.handoff_contract.handoff_file].filter((value) => typeof value === "string" && value);
  for (const destination of destinations) {
    if (!seed.scope.write.includes(destination)) seed.scope.write.push(destination);
    const conflictWrite = seed.concurrency_contract?.conflict_keys?.write;
    if (Array.isArray(conflictWrite) && !conflictWrite.includes(destination)) conflictWrite.push(destination);
  }
  if (truthyText(seed.runtime_context.network_needed) || seed.tool_contract.network_allowed === true) {
    seed.runtime_context.network_needed = "yes";
    seed.tool_contract.network_allowed = true;
  }
  delete seed.runtime_context.agent_runtime_consent;
  delete seed.handoff_contract.parent_consume_action;
  delete seed.ownership.unlock_conditions;
  if (Array.isArray(seed.tool_contract.allowed)) {
    seed.tool_contract.allowed = [...new Set(seed.tool_contract.allowed.map((item) => typeof item === "string" ? item.trim() : item))];
  } else if (seed.tool_contract.allowed == null) {
    seed.tool_contract.allowed = null;
  }
  const executor = seed.extensions?.capability_contract?.executor;
  if (seed.route_id === "executor-agent__plan-execution" && isRecord(executor)) {
    if (!Object.hasOwn(executor, "execution_adjustment_policy")) executor.execution_adjustment_policy = {};
    const policy = executor.execution_adjustment_policy;
    if (isRecord(policy) && !Object.hasOwn(policy, "allowed_kinds")) policy.allowed_kinds = [...PLAN_EXECUTION_ADJUSTMENT_KINDS];
  }
  const scoped = executor?.scoped;
  if (isRecord(scoped?.ref_resolution) && !(scoped.operation_type === "source_clone_only" && scoped.ref_resolution.if_missing === "fallback_default_branch")) {
    delete scoped.ref_resolution.fallback_ref;
  }
  seed.handoff_contract.require_final_handoff = true;
  return seed;
}
function aliasValue(object, canonical, legacy, label, issues) {
  if (Object.hasOwn(object, canonical)) {
    if (Object.hasOwn(object, legacy) && object[canonical] !== object[legacy]) {
      issues.push(`${label}.${legacy} conflicts with ${label}.${canonical}; provide one value`);
    }
    return object[canonical];
  }
  return object[legacy];
}
function checkExpectedOutputContract(expected) {
  const issues = [];
  const filePath = aliasValue(expected, "file_path", "path", "expected_output", issues);
  const mode = pyGet(expected, "mode");
  if (mode !== "file") {
    issues.push("expected_output.mode must be file");
    return issues;
  }
  if (typeof filePath !== "string" || !filePath) {
    issues.push("expected_output.mode=file requires expected_output.file_path");
  }
  return issues;
}
function checkHandoffContract(handoff) {
  const issues = [];
  aliasValue(handoff, "require_final_handoff", "final_response_required", "handoff_contract", issues);
  const acceptVerdicts = pyGet(handoff, "accept_verdicts");
  if (!Array.isArray(acceptVerdicts) || !acceptVerdicts.length) {
    issues.push("handoff_contract.accept_verdicts must be a non-empty list");
  } else {
    const invalid = acceptVerdicts.filter((item) => !FINAL_HANDOFF_VERDICTS.has(item)).map(pyStr);
    if (invalid.length) {
      issues.push(`handoff_contract.accept_verdicts contains invalid verdicts: ${invalid.join(", ")}`);
    }
  }
  if (typeof pyGet(handoff, "handoff_file_required") !== "boolean") {
    issues.push("handoff_contract.handoff_file_required must be boolean");
  }
  if (pyTruthy(pyGet(handoff, "handoff_file_required")) && !pyTruthy(pyGet(handoff, "handoff_file"))) {
    issues.push("handoff_contract.handoff_file is required when handoff_file_required=true");
  }
  return issues;
}
function validateBody(seed, routeId2) {
  const missing = SEED_BODY_REQUIRED.filter((key) => !Object.hasOwn(seed, key));
  if (missing.length) {
    throw new ToolError(`package_seed missing required body fields for ${routeId2}: ${missing.join(", ")}`);
  }
  requireDict(seed, "project_positioning");
  requireString(seed, "goal");
  const scope = scopeFromSeed(seed);
  requireDict(seed, "ownership");
  requireDict(seed, "concurrency_contract");
  requireDict(seed, "inputs");
  requireList(seed, "known_facts");
  const expected = requireDict(seed, "expected_output");
  const runtime = requireDict(seed, "runtime_context");
  requireDict(seed, "alignment");
  requireDict(seed, "planning_policy");
  requireDict(seed, "tool_contract");
  requireList(seed, "stop_conditions");
  requireDict(seed, "extensions");
  const handoff = requireDict(seed, "handoff_contract");
  const issues = [
    ...checkExpectedOutputContract(expected),
    ...checkHandoffContract(handoff)
  ];
  if (issues.length) throw new ToolError(issues[0]);
  const filePath = Object.hasOwn(expected, "file_path") ? expected.file_path : expected.path;
  repoOrTargetAbsPath(filePath, runtime, "expected_output.file_path");
  for (const item of scope.write) repoOrTargetAbsPath(item, runtime, "scope.write");
  for (const item of scope.delete) repoAbsPath(item, "scope.delete");
  const handoffFile = pyGet(handoff, "handoff_file", null);
  if (handoffFile !== null && handoffFile !== void 0) repoAbsPath(handoffFile, "handoff_contract.handoff_file");
  return null;
}
function enrichRuntimeContext(runtimeContext) {
  const runtime = deepCopy(runtimeContext);
  const cwdDefault = ROOT;
  if (!Object.hasOwn(runtime, "cwd")) runtime.cwd = cwdDefault;
  runtime.output_root = ROOT;
  const gitDefault = {
    branch: gitValue(["branch", "--show-current"], "(unknown)"),
    head: gitValue(["rev-parse", "--short=12", "HEAD"], "(unknown)")
  };
  if (!Object.hasOwn(runtime, "git")) runtime.git = gitDefault;
  return runtime;
}
function enrichExpectedOutput(expectedOutput, runtimeContext) {
  const expected = deepCopy(expectedOutput);
  if (pyGet(expected, "mode") === "file" && typeof pyGet(expected, "file_path") === "string") {
    expected.resolved_file_path = repoOrTargetAbsPath(
      pyGetItem(expected, "file_path"),
      runtimeContext,
      "expected_output.file_path"
    );
  }
  return expected;
}
function enrichHandoffContract(handoffContract) {
  const handoff = deepCopy(handoffContract);
  const handoffFile = pyGet(handoff, "handoff_file");
  if (typeof handoffFile === "string" && handoffFile.trim()) {
    handoff.resolved_handoff_file = repoAbsPath(handoffFile, "handoff_contract.handoff_file");
  } else {
    handoff.resolved_handoff_file = null;
  }
  return handoff;
}
function buildPackage(seed) {
  const routeId2 = routeIdFromSeed(seed);
  const profile = profileFor(routeId2);
  validateBody(seed, routeId2);
  seed = projectDeclarations(seed);
  const pkgId = packageId(routeId2, seed);
  const pkg = {
    version: pyStr(pyGet(seed, "version", "1")),
    package_id: pkgId,
    agent: deepCopy(pyGetItem(profile, "agent")),
    project_positioning: seed.project_positioning,
    goal: seed.goal,
    scope: {
      read: seed.scope.read,
      write: seed.scope.write,
      delete: seed.scope.delete,
      out_of_scope: seed.scope.out_of_scope
    },
    ownership: seed.ownership,
    concurrency_contract: seed.concurrency_contract,
    inputs: seed.inputs,
    known_facts: seed.known_facts,
    expected_output: enrichExpectedOutput(seed.expected_output, seed.runtime_context),
    runtime_context: enrichRuntimeContext(seed.runtime_context),
    alignment: seed.alignment,
    planning_policy: seed.planning_policy,
    tool_contract: seed.tool_contract,
    stop_conditions: seed.stop_conditions,
    extensions: seed.extensions,
    handoff_contract: enrichHandoffContract(seed.handoff_contract)
  };
  return { task_package: pkg };
}
function sampleSeed(routeId2) {
  const parts = String(routeId2).split("__");
  if (parts.length < 2) throw pyError("ValueError", "not enough values to unpack (expected 2, got 1)");
  const role = parts[0];
  const capability = parts.slice(1).join("__");
  const promptKey = capability.replaceAll("-", "_");
  return {
    route_id: routeId2,
    goal: `\u6784\u9020 ${routeId2} \u7684\u7EDF\u4E00\u5B8C\u6574 seed \u81EA\u6D4B\u5305\u3002`,
    project_positioning: {
      project: readProjectName(),
      status: "tool self-test",
      roadmap: "tool self-test"
    },
    scope: {
      read: ["AGENTS.md"],
      write: [`notes/manifests/${routeId2}-self-test.md`],
      delete: [],
      out_of_scope: ["\u7981\u6B62\u4FEE\u6539\u6587\u4EF6", "\u7981\u6B62\u63D0\u4EA4", "\u7981\u6B62\u8054\u7F51"]
    },
    ownership: {
      owner: "child_agent",
      parent_forbidden_same_scope_probe: true
    },
    concurrency_contract: {
      group_id: `self-test-${routeId2}`,
      lane_id: "single",
      depends_on: [],
      conflict_keys: {
        read: ["AGENTS.md"],
        write: [`notes/manifests/${routeId2}-self-test.md`],
        delete: [],
        output: `notes/manifests/${routeId2}-self-test.md`
      },
      parallel_policy: "single_lane"
    },
    inputs: {
      route_id: routeId2,
      route_file: `ops/protocols/task-package-routes/${routeId2}.md`,
      question: "\u786E\u8BA4\u7EDF\u4E00\u5B8C\u6574 seed \u53EF\u4EE5\u6784\u5305\u3002"
    },
    known_facts: [],
    expected_output: {
      mode: "file",
      file_path: `notes/manifests/${routeId2}-self-test.md`,
      required_sections: ["scope", "summary", "findings"],
      business_gate: `${promptKey}_gate`
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
      reason: "tool self-test"
    },
    tool_contract: {
      allowed: null,
      forbidden: ["write_outside_scope", "git_commit", "network", "install_dependencies"],
      network_allowed: false,
      install_allowed: false
    },
    stop_conditions: [
      "required input file missing",
      "scope authorization conflict",
      "output contract cannot be satisfied"
    ],
    extensions: {
      capability_contract: {
        [promptKey]: {
          self_test: true,
          role,
          capability
        }
      }
    },
    handoff_contract: {
      handoff_file_required: false,
      handoff_file: null,
      accept_verdicts: ["done", "partial", "needs_owner", "failed", "pass", "fail"]
    }
  };
}
var PLAN_EXECUTION_ADJUSTMENT_KINDS, FINAL_HANDOFF_VERDICTS, TRUTHY_TEXT;
var init_task_package_build = __esm({
  "ops/tools/dispatch-core/task_package_build.mjs"() {
    init_tool_common();
    init_py();
    init_task_package_profiles();
    PLAN_EXECUTION_ADJUSTMENT_KINDS = [
      "equivalent_command",
      "unique_path_resolution",
      "semantics_preserving_step_reorder"
    ];
    FINAL_HANDOFF_VERDICTS = /* @__PURE__ */ new Set(["done", "partial", "needs_owner", "needs_split", "failed", "pass", "fail"]);
    TRUTHY_TEXT = /* @__PURE__ */ new Set(["1", "true", "yes", "y", "on"]);
  }
});

// ops/tools/dispatch-core/review_evidence.mjs
import { spawnSync as spawnSync4 } from "node:child_process";
import { opendirSync, readdirSync as readdirSync4, statSync as statSync7 } from "node:fs";
import path9 from "node:path";
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
function routeId(pkg) {
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const role = String(agent.role || "");
  const name = String(capability.name || "");
  return `${role}__${name}`;
}
function capabilityContract(pkg, rid) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const contracts = isRecord(extensions.capability_contract) ? extensions.capability_contract : {};
  if (!Object.hasOwn(CONTRACT_SLOTS, rid)) throw pyError("KeyError", pyRepr(rid));
  const value = contracts[CONTRACT_SLOTS[rid]];
  return isRecord(value) ? value : {};
}
function isStaticReview(pkg) {
  const rid = routeId(pkg);
  if (!STATIC_REVIEW_ROUTES.has(rid)) return false;
  if (rid === "verify-agent__code-verification") {
    const contract = capabilityContract(pkg, rid);
    if (contract.verify_mode !== "verification") return false;
    const acceptance = contract.acceptance_context;
    return !(isRecord(acceptance) && Object.keys(acceptance).length > 0);
  }
  return true;
}
function reviewRoot(pkg) {
  const runtime = isRecord(pkg?.runtime_context) ? pkg.runtime_context : {};
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
  const completed = spawnSync4(command[0], command.slice(1), {
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
      entry.entries = readdirSync4(target).length;
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
        const full = path9.join(current, entry.name);
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
    const logPath = path9.join(String(logRoot), `${safe}.log`);
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
function buildEvidence(pkg, options = {}) {
  const { execute, root = null, logRoot = null, outputRoot = null, outputPath = null } = options;
  const rid = routeId(pkg);
  const contract = capabilityContract(pkg, rid);
  const scope = isRecord(pkg?.scope) ? pkg.scope : {};
  const scopeRead = Array.isArray(scope.read) ? uniqueStrings(scope.read) : [];
  const base = resolveLikePython(root || reviewRoot(pkg));
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
      logs = evidenceLogDirectory(evidenceOutputPath(pkg, { outputRoot, outputPath }));
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
  const closedDossier = Array.isArray(pkg?.tool_contract?.allowed) && pkg.tool_contract.allowed.length === 0;
  const omittedContractKeys = /* @__PURE__ */ new Set(["mechanical_checks", "output_report"]);
  if (rid === "verify-agent__code-verification") omittedContractKeys.add("affected_files");
  const reviewContract = Object.fromEntries(
    Object.entries(contract).filter(([key]) => !omittedContractKeys.has(key))
  );
  const evidence = {
    schema_version: 1,
    route_id: rid,
    profile: semanticReview ? SEMANTIC_PROFILE : closedDossier && complete && !truthyText(pkg?.runtime_context?.network_needed) ? PROFILE : ASSISTED_PROFILE,
    complete,
    goal: pkg?.goal ?? null,
    contract: reviewContract,
    known_facts: Object.hasOwn(pkg, "known_facts") ? pkg.known_facts : [],
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
  const parsed = path9.parse(target);
  const stripped = parsed.ext ? path9.join(parsed.dir, parsed.name) : target;
  return stripped !== target ? stripped : path9.join(parsed.dir, `${parsed.base}.logs`);
}
function evidenceOutputPath(pkg, options = {}) {
  const { outputRoot = null, outputPath = null } = options;
  const packageId2 = String(pkg?.package_id || "package");
  if (outputPath !== null && outputPath !== void 0) {
    return lexicalAbsolute(outputPath);
  }
  if (outputRoot !== null && outputRoot !== void 0) {
    const root2 = lexicalAbsolute(outputRoot);
    if (path9.extname(root2).toLowerCase() === ".json" || Boolean(statOrNull2(root2)?.isFile())) return root2;
    return assertDerivedOutputContained(path9.join(root2, derivedEvidenceFilename(packageId2)), root2);
  }
  const root = lexicalAbsolute(path9.join(ROOT, "tmp", "review_evidence"));
  return assertDerivedOutputContained(path9.join(root, derivedEvidenceFilename(packageId2)), root);
}
function attachReviewEvidence(envelope, options = {}) {
  const { execute, root = null, outputRoot = null, outputPath = null } = options;
  const pkg = isRecord(envelope?.task_package) ? envelope.task_package : envelope;
  if (!isRecord(pkg) || !isStaticReview(pkg)) return null;
  const output = evidenceOutputPath(pkg, { outputRoot, outputPath });
  const evidence = buildEvidence(pkg, {
    execute,
    root,
    logRoot: evidenceLogDirectory(output),
    outputRoot,
    outputPath
  });
  const sourceCount = evidence.sources.length;
  const checkCount = evidence.mechanical_checks.length;
  const checkFailures = evidence.mechanical_checks.filter((item) => !item.passed).length;
  if (!Object.hasOwn(pkg, "extensions")) pkg.extensions = {};
  const extensions = pkg.extensions;
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
      profile: evidence.profile === SEMANTIC_PROFILE ? SEMANTIC_PROFILE : truthyText(pkg?.runtime_context?.network_needed) ? ASSISTED_PROFILE : "preview",
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
    contract_slot: CONTRACT_SLOTS[routeId(pkg)]
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
function selectionSummary(selection) {
  if (!selection) return "\u672A\u89E3\u6790";
  const requested = selection.requested || {};
  const source = requested.pick ? `pick:${requested.pick}` : requested.model ? `model:${requested.model}` : `\u9ED8\u8BA4:${selection.pick}`;
  const applied = (selection.authorization?.applied_overrides || []).map((item) => item.kind).join("\u3001") || "\u65E0";
  return `${selection.resolved_model}@${selection.resolved_effort} \xB7 ${source} \xB7 \u6388\u6743\u89E3\u9664:${applied}`;
}
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
import { createHash as createHash4 } from "node:crypto";
import { existsSync as existsSync5, readdirSync as readdirSync5, readFileSync as readFileSync7 } from "node:fs";
import path10 from "node:path";
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
  if (!text2(file) || !existsSync5(file)) fail("file_invalid", file || "(missing)", "", "\u6587\u4EF6\u4E0D\u5B58\u5728");
  try {
    return parse(readFileSync7(file, "utf8").replace(/^﻿/, ""));
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
  const dir = root ? path10.join(root, "ops", "protocols", "task-package-routes") : "";
  if (!dir || !existsSync5(dir)) return [];
  const routes = [];
  for (const name of readdirSync5(dir).filter((item) => item.endsWith(".md")).sort()) {
    const file = path10.join(dir, name);
    const body = readFileSync7(file, "utf8");
    const agent = AGENT_BLOCK_RE2.exec(body);
    if (!agent) continue;
    const role = /(?:^|\n)\s*role:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    const capability = /capability:\s*\n(?:[^\n]*\n){0,4}?\s*name:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    if (!role || !capability) continue;
    let card = {};
    let phaseError = null;
    try {
      card = JSON.parse(CARD_RE2.exec(body)?.[1] ?? "{}");
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
  if (`${role}.toml` !== path10.basename(file)) fail("value_invalid", file, "name", `\u4E0E\u6587\u4EF6\u540D\u4E0D\u4E00\u81F4\uFF1A${role}`);
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
  for (const dir of [sources.agents_dir, text2(sources.global_root) ? path10.join(sources.global_root, "ops", "agents") : ""]) {
    if (!text2(dir) || !existsSync5(dir)) continue;
    for (const name of readdirSync5(dir)) if (ROLE_FILE_RE.test(name)) names.add(name.slice(0, -".toml".length));
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
    if (existsSync5(file)) roles.set(name, loadRoleFile(file, routes, notes));
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
function resolveWorkerResources(config, roleName, capability) {
  const role = roleRecord(config, roleName);
  requireCapability(role, capability);
  const effective = role.capabilities.has(capability) ? role.capabilities.get(capability).worker_resources : role.worker_resources;
  return effective ? structuredClone(effective) : null;
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
  return `sha256:${createHash4("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
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
function capabilityRow(role, id) {
  const route = role.routes.find((item) => item.capability === id);
  return {
    id,
    route_id: route?.route_id ?? `${role.role}__${id}`,
    description: route?.description ?? "",
    dispatch_phase: route?.dispatch_phase ?? null,
    default_pick: effectiveDefault(role, id)?.id ?? null,
    inherit_role_picks: inherits(role, id)
  };
}
function projectCatalog(config, { piModels = null, role: roleFilter = "", capability = "" } = {}) {
  const pi = piModels ? new Set(piModels) : null;
  const picked = [...config.roles.values()].flatMap((role) => role.picks.map((pick) => pick.model));
  const models = [.../* @__PURE__ */ new Set([...piModels ?? [], ...config.notes.keys(), ...picked])].map((model) => {
    const note = config.notes.get(model);
    return {
      model,
      tag: note?.tag ?? "",
      supports_vision: note?.supports_vision ?? null,
      efforts: modelEfforts(config, model),
      effort_note: note?.effort_note ?? "",
      in_pi: pi ? pi.has(model) : null
    };
  });
  const warnings = [...config.warnings];
  const roles = [];
  for (const role of config.roles.values()) {
    if (roleFilter && role.role !== roleFilter) continue;
    if (capability) requireCapability(role, capability);
    const shown = capability ? applicable(role, capability) : role.picks;
    if (pi) {
      role.picks.forEach((pick, index) => {
        if (shown.includes(pick) && !pi.has(pick.model)) {
          warnings.push({
            code: "model_not_in_pi",
            file: role.file,
            field: `picks[${index}].model`,
            role: role.role,
            pick_id: pick.id,
            message: `${pick.model} \u4E0D\u5728\u5F53\u524D Pi \u6A21\u578B\u6E05\u5355\u4E2D`
          });
        }
      });
    }
    roles.push({
      role: role.role,
      description: role.description,
      capabilities: (capability ? [capability] : [...role.known_capabilities]).map((id) => capabilityRow(role, id)),
      picks: shown.map((pick) => ({ ...pick }))
    });
  }
  if (roleFilter && !roles.length) throw new ToolError(`\u672A\u77E5\u89D2\u8272\uFF1A${roleFilter}`);
  return { config_source: config.config_source, config_fingerprint: selectionConfigFingerprint(config, { role: roleFilter }), models, roles, warnings };
}
var EFFORT_LEVELS, ID_RE, ROLE_FILE_RE, PICK_KEYS, NOTE_KEYS, REMOVED_ROLE_KEYS, REMOVED_NOTE_KEYS, WORKER_RESOURCE_LISTS, PROJECT_SKILL_MODES, AGENT_BLOCK_RE2, CARD_RE2, rank;
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
    AGENT_BLOCK_RE2 = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
    CARD_RE2 = /```json\s+route_card\s*\n([\s\S]*?)\n```/;
    rank = (level) => EFFORT_LEVELS.indexOf(level);
  }
});

// ops/tools/dispatch-core/seed_minimal.mjs
import path11 from "node:path";
function deepCopy2(value) {
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
function cardFor(routeId2) {
  const card = pyGet(profileFor(routeId2), "card");
  return card === void 0 ? null : card;
}
function routesWithCards() {
  const profiles = routeProfiles();
  return Object.entries(profiles).filter(([, profile]) => pyTruthy(pyGet(profile, "card"))).map(([routeId2]) => routeId2).sort();
}
function listCards() {
  const rows = [];
  const profiles = routeProfiles();
  for (const routeId2 of Object.keys(profiles).sort()) {
    const card = pyGet(profiles[routeId2], "card");
    const source = isRecord(card) ? card : {};
    rows.push({
      route_id: routeId2,
      minimal_seed: pyTruthy(card),
      applies_to: pyGet(source, "applies_to", ""),
      model_tier: pyGet(source, "model_tier", ""),
      model_requirements: pyGet(source, "model_requirements", [])
    });
  }
  return rows;
}
function setPath(data, dotted, value) {
  let cursor = data;
  const keys = String(dotted).split(".");
  for (const key of keys.slice(0, -1)) cursor = setDefaultDict(cursor, key);
  cursor[keys[keys.length - 1]] = deepCopy2(value);
  return null;
}
function exampleSeed(routeId2) {
  const card = cardFor(routeId2);
  if (card === null) throw new ToolError(`route ${routeId2} has no route_card`);
  const seed = { route_id: routeId2 };
  for (const req of pyGet(card, "required", [])) {
    let example = pyGet(req, "example");
    if (example === void 0 || example === null) {
      const enumValues = pyOr(pyGet(req, "enum"), [null]);
      example = enumValues[0] ?? null;
    }
    setPath(seed, pyGetItem(req, "path"), example);
  }
  return applyInputDefaults(seed, card);
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
    else base[key] = deepCopy2(value);
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
      return deepCopy2(inner);
    }
    if (isRecord(ctx) && Object.hasOwn(ctx, key)) return deepCopy2(ctx[key]);
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
  const normalized = deepCopy2(seed);
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
    const fullSeed = injectPlannerMechanicalSchema(deepCopy2(seed));
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
    if (Object.hasOwn(seed.contract ?? {}, field)) contract[field] = deepCopy2(seed.contract[field]);
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
    else full[key] = deepCopy2(value);
  }
  injectPlannerMechanicalSchema(full);
  injectAcceptanceMechanicalContract(full);
  alignExpectedOutputWrite(full, reportPath, writeExtra);
  alignHandoffOutputWrite(full, handoffPath, writeExtra);
  return full;
}
function renderTemplate(routeId2) {
  const profile = profileFor(routeId2);
  const card = pyGet(profile, "card");
  if (card === null || card === void 0) {
    throw new ToolError(
      `route ${routeId2} \u6CA1\u6709\u5DEE\u5F02\u5361\uFF1B\u5DF2\u652F\u6301\u6700\u5C0F\u79CD\u5B50\u7684 route: ${pyOr(routesWithCards().join(", "), "(none)")}`
    );
  }
  const body = { route_id: routeId2 };
  for (const req of pyGet(card, "required", [])) {
    const reqPath = pyGetItem(req, "path");
    const hint = pyGet(req, "hint", "");
    const enumValues = pyGet(req, "enum");
    const example = pyGet(req, "example", null);
    let placeholder;
    if (pyTruthy(enumValues)) {
      placeholder = `<${enumValues.join("|")}${pyTruthy(hint) ? ` \u2014 ${hint}` : ""}>`;
    } else {
      const parts = pyTruthy(hint) ? [hint] : [];
      if (example !== null && example !== void 0 && !(typeof example === "string" && example.startsWith("$"))) {
        parts.push(`\u4F8B: ${pyJsonDumps(example)}`);
      }
      placeholder = `<${pyOr(parts.join(" | "), reqPath)}>`;
    }
    let cursor = body;
    const keys = String(reqPath).split(".");
    for (const key of keys.slice(0, -1)) {
      let node = pyGet(cursor, key);
      if (!isRecord(node)) {
        node = {};
        cursor[key] = node;
      }
      cursor = node;
    }
    const leaf = keys[keys.length - 1];
    cursor[leaf] = Array.isArray(example) ? [placeholder] : placeholder;
  }
  for (const opt of pyGet(card, "optional", [])) {
    const optPath = pyGetItem(opt, "path");
    const hint = pyGet(opt, "hint", "");
    let cursor = body;
    const keys = String(optPath).split(".");
    for (const key of keys.slice(0, -1)) {
      let node = pyGet(cursor, key);
      if (!isRecord(node)) {
        node = {};
        cursor[key] = node;
      }
      cursor = node;
    }
    const enumValues = pyGet(opt, "enum");
    const valuesHint = pyTruthy(enumValues) ? `${enumValues.join("|")} \u2014 ` : "";
    const placeholder = `<\u53EF\u9009 | ${valuesHint}${pyOr(hint, optPath)}>`;
    cursor[keys[keys.length - 1]] = LIST_SEED_FIELDS.has(optPath) ? [placeholder] : placeholder;
  }
  if (pyGet(card, "omit_delegation_intent") !== true) {
    body.delegation_intent = "<\u53EF\u9009 | 1-3 \u53E5\u8BF4\u660E\u4E3A\u4EC0\u4E48\u6D3E\u3001\u8981\u6D88\u54EA\u4E2A\u4E0D\u786E\u5B9A\u3001\u7ED3\u679C\u4F1A\u5F71\u54CD\u4E3B\u4EE3\u7406\u4EC0\u4E48\u51B3\u5B9A\uFF1B\u4E0D\u5199\u4E8B\u5B9E\u3001\u7ED3\u8BBA\u6216\u5386\u53F2\u957F\u6458\u5F55>";
  }
  const [role, capability] = routeId2.split("__");
  const sources = modelConfigSources();
  const modelTier = pyStr(pyOr(pyGet(card, "model_tier"), "")).trim();
  const config = loadSelectionConfig(sources);
  const projectedRole = projectCatalog(config, { role, capability }).roles[0];
  const defaultPick = projectedRole.capabilities[0].default_pick;
  const header = [
    `# minimal seed \xB7 ${routeId2}`,
    `# \u9002\u7528: ${pyGet(card, "applies_to", "")}`,
    `# \u6709\u6548\u9ED8\u8BA4: ${defaultPick || "\u672A\u914D\u7F6E"}`,
    ...projectedRole.picks.map((pick) => `# \u63A8\u8350 ${pick.id}${pick.id === defaultPick ? "\uFF08\u9ED8\u8BA4\uFF09" : ""}: ${pick.when} \u2192 ${pick.model}@${pick.effort} [${pick.effort_min}\u2013${pick.effort_max}]\uFF1B\u9009\u62E9 ${JSON.stringify({ pick: pick.id })}\uFF1B\u6A21\u578B\u53EF\u9009\u6863\u4F4D ${modelEfforts(config, pick.model).join("/")}`),
    `# \u914D\u7F6E\u6765\u6E90: \u89D2\u8272=${sources.roleConfigPath(role)}\uFF1B\u6A21\u578B\u7B14\u8BB0=${sources.model_notes}`,
    ...modelTier ? [`# \u5361\u63D0\u793A: ${modelTier}`] : [],
    ...pyTruthy(pyGet(card, "model_requirements")) ? [`# \u6A21\u578B\u8981\u6C42: ${pyGetItem(card, "model_requirements").map(pyStr).join(", ")}`] : [],
    ...MODEL_SELECTION_GUIDANCE.map((line) => `# \u9009\u578B: ${line}`),
    ...Object.entries(card.input_defaults ?? {}).map(([key, value]) => `# \u7F3A\u7701: ${key} = ${pyJsonDumps(value)}`),
    "# \u5176\u4F59\u5B57\u6BB5\u5168\u90E8\u7531\u5DE5\u5177\u6309\u5DEE\u5F02\u5361\u9ED8\u8BA4\uFF1Bscope.write \u81EA\u52A8\u542B\u9884\u671F\u8F93\u51FA\u548C handoff\uFF0C\u4E1A\u52A1\u5199\u5165\u7528 scope.write_extra \u6DFB\u52A0\u3002",
    "# <\u53EF\u9009> \u5B57\u6BB5\u4E0D\u9700\u8981\u65F6\u6574\u884C\u5220\u9664\u3002CLI flag \u4E0E Pi \u6269\u5C55\u5DE5\u5177\u53C2\u6570\u4E0D\u53EF\u6DF7\u7528\u3002",
    "# \u914D\u7F6E\u5F52\u5C5E\u53D1\u8D77\u9879\u76EE\uFF1Btarget_cwd \u6307\u5B9A\u5B50\u4EE3\u7406\u6267\u884C\u76EE\u5F55\u548C\u5199\u57DF\u6821\u9A8C\u7684\u76EE\u6807\u4ED3\uFF0C\u5177\u4F53\u5199\u5165\u4ECD\u7531 scope \u6388\u6743\u3002"
  ];
  return `${header.join("\n")}
${JSON.stringify(body, null, 2)}`;
}
var PLACEHOLDER_RE, FULL_SEED_FIELDS, MINIMAL_ONLY_KEYS, LIST_SEED_FIELDS, PLANNER_SCHEMA_LIST_KEYS, schemaCache;
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
    LIST_SEED_FIELDS = /* @__PURE__ */ new Set([
      "known_facts",
      "scope.write_extra",
      "scope.delete",
      "scope.out_of_scope_extra",
      "contract.mechanical_checks",
      "contract.required_sections"
    ]);
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
import { opendirSync as opendirSync2, statSync as statSync8 } from "node:fs";
import path12 from "node:path";
function jsonErrorLine2(text3, error) {
  const message = String(error?.message ?? "");
  const line = /\(line (\d+) column \d+\)/.exec(message);
  if (line) return Number(line[1]);
  const position = /position (\d+)/.exec(message);
  if (position) return text3.slice(0, Number(position[1])).split("\n").length;
  return 1;
}
function orNull(value) {
  return value === void 0 ? null : value;
}
function isFile3(target) {
  try {
    return statSync8(target).isFile();
  } catch {
    return false;
  }
}
function repoPath(value) {
  const raw = pyStrip(pyStr(pyOr(value, "")));
  if (!raw) throw new ToolError("empty required_files path");
  const projectReal = resolveLikePython(ROOT);
  const lexical = path12.resolve(ROOT, raw);
  const lexicalRelative = path12.relative(projectReal, lexical);
  if (lexicalRelative.startsWith("..") || path12.isAbsolute(lexicalRelative)) {
    throw new ToolError(`required file escapes repository: ${raw}`);
  }
  const resolved = resolveLikePython(lexical);
  const relative = path12.relative(projectReal, resolved);
  if (relative.startsWith("..") || path12.isAbsolute(relative)) {
    if (!isSameOrInside(resolved, RUNTIME_ROOT)) {
      throw new ToolError(`required file escapes repository: ${raw}`);
    }
  }
  if (!isFile3(resolved)) throw new ToolError(`required file not found: ${raw}`);
  return resolved;
}
function packageFromData(data) {
  if (!isRecord(data)) throw pyError("AttributeError", `'${pyTypeName(data)}' object has no attribute 'get'`);
  const pkg = Object.hasOwn(data, "task_package") ? data.task_package : data;
  if (!isRecord(pkg)) throw new ToolError("task_package root is not an object");
  const agent = pkg.agent;
  if (!isRecord(agent)) throw new ToolError("task_package.agent is missing or not an object");
  const requiredFiles = agent.required_files;
  if (!Array.isArray(requiredFiles) || !requiredFiles.every((item) => typeof item === "string")) {
    throw new ToolError("task_package.agent.required_files must be a string list");
  }
  const role = pyStrip(pyStr(pyOr(agent.role, agent.runtime_role, "")));
  if (!role) throw new ToolError("task_package.agent.role is missing");
  return pkg;
}
function loadPackage(file) {
  return packageFromData(loadJson(file));
}
function readRequiredFiles(pkg) {
  const files = [];
  for (const item of pyGetItem(pyGetItem(pkg, "agent"), "required_files")) {
    const target = resolveLikePython(path12.resolve(RUNTIME_ROOT, item));
    if (!isSameOrInside(target, RUNTIME_ROOT)) throw new ToolError(`required prompt escapes runtime: ${item}`);
    files.push({ path: item, content: pyReadText(target) });
  }
  return files;
}
function roleDeveloperInstructions(pkg) {
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const role = pyStrip(pyStr(pyOr(agent.runtime_role, agent.role, "")));
  const roleConfig = loadRoleConfig(role, { globalDefault: true });
  const rolePath = path12.join(RUNTIME_ROOT, "ops", "agents", `${role}.toml`);
  const instructions = pyStrip(pyStr(pyOr(roleConfig.developer_instructions, "")));
  if (!instructions) throw new ToolError(`runtime role has no developer_instructions: ${role}`);
  return { path: rel(rolePath), content: instructions };
}
function reviewEvidenceSupport(pkg) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const reference = isRecord(extensions.review_evidence) ? extensions.review_evidence : {};
  const rawPath = reference.path;
  if (typeof rawPath !== "string" || !pyStrip(rawPath)) return null;
  const target = repoPath(rawPath);
  try {
    const info = statSync8(target);
    if (info.isFile() && info.size > REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET) {
      return {
        path: rawPath,
        heading: "\u673A\u68B0\u8BC1\u636E\u5305",
        content: `${JSON.stringify({
          schema_version: 1,
          injection_bounded: true,
          omitted: true,
          complete: false,
          path: rawPath,
          bytes: info.size,
          byte_budget: REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET,
          reason: "review evidence exceeds injection byte budget and was not preloaded",
          read_authorization: "unchanged"
        })}
`
      };
    }
  } catch {
  }
  let content;
  try {
    content = pyReadText(target);
  } catch (error) {
    if (error?.name === "UnicodeDecodeError") throw new ToolError(`review evidence is not valid UTF-8: ${rawPath}`);
    throw error;
  }
  let evidence;
  try {
    evidence = JSON.parse(content);
  } catch (error) {
    throw new ToolError(`review evidence is not valid JSON: ${rawPath}:${jsonErrorLine2(content, error)}`);
  }
  if (!isRecord(evidence)) throw new ToolError(`review evidence JSON root must be an object: ${rawPath}`);
  return { path: rawPath, content, heading: "\u673A\u68B0\u8BC1\u636E\u5305" };
}
function reviewCoverageFiles(pkg) {
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const capabilityName = pyStr(pyOr(capability.name, "")).replaceAll("-", "_");
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const contracts = isRecord(extensions.capability_contract) ? extensions.capability_contract : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  const contractSlot = pyStrip(pyStr(pyOr(review.contract_slot, "")));
  const direct = contractSlot ? contracts[contractSlot] : contracts[capabilityName];
  const candidates = Object.values(contracts).filter((value) => isRecord(value));
  const contract = isRecord(direct) ? direct : !contractSlot && candidates.length === 1 ? candidates[0] : {};
  const rawFiles = Array.isArray(contract.target_files) ? contract.target_files : contract.affected_files;
  const coverageFiles = Array.isArray(rawFiles) ? rawFiles : [];
  return coverageFiles.filter((item) => pyStrip(pyStr(item))).map((item) => pyStr(item));
}
function outputTemplateFor(pkg) {
  const extensions = isRecord(pkg) && isRecord(pkg.extensions) ? pkg.extensions : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  const hasCoverageFiles = reviewCoverageFiles(pkg).length > 0;
  const reviewedExample = hasCoverageFiles ? '["$target_files"]' : '["<exact path from task_package.scope.read>"]';
  const coverageHint = hasCoverageFiles ? "\u5B8C\u6574\u8986\u76D6\u80FD\u529B\u5408\u540C\u6295\u5F71\u7684\u6587\u4EF6\u96C6\u5408\u65F6\u4F7F\u7528 `$target_files`\uFF1B\u90E8\u5206\u8986\u76D6\u4F7F\u7528\u7CBE\u786E\u8DEF\u5F84\u5E76\u8FD4\u56DE needs_owner\u3002" : "\u4ECE task_package.scope.read \u7CBE\u786E\u5217\u51FA\u5B9E\u9645\u6D88\u8D39\u8DEF\u5F84\uFF1B\u672A\u6D88\u8D39\u8DEF\u5F84\u8FDB\u5165 not_reviewed \u5E76\u8FD4\u56DE needs_owner\u3002";
  const semanticReview = review.profile === "semantic_review_v2";
  const actualReadsField = semanticReview ? ',"actual_reads":["<\u5B9E\u9645\u6D88\u8D39\u7684\u6388\u6743\u8DEF\u5F84>"]' : "";
  const actualReadsHint = semanticReview ? "`scope.read` \u662F\u8BFB\u53D6\u6388\u6743\uFF0C\u4E0D\u662F\u5168\u6587\u6D88\u8D39\u4E49\u52A1\u3002\u6309\u672C\u6B21\u76EE\u6807\u6838\u5BF9 target_files \u4E2D\u7684\u5BA1\u67E5\u5BF9\u8C61\u4E0E\u5FC5\u8981\u4E0A\u4E0B\u6E38\uFF1B`actual_reads` \u5217\u5B9E\u9645\u6D88\u8D39\u7684\u7CBE\u786E\u8DEF\u5F84\uFF0C\u786E\u5DF2\u5168\u90E8\u6D88\u8D39\u65F6\u53EF\u7B80\u5199 `$scope_read`\u3002\u672A\u8BFB\u7684\u975E\u76EE\u6807\u6388\u6743\u6750\u6599\u4E0D\u6784\u6210\u7F3A\u53E3\uFF1B\u7F3A\u5C11\u5B8C\u6210\u76EE\u6807\u6240\u9700\u8BC1\u636E\u65F6\u624D\u8BB0\u5F55 evidence_gaps \u5E76\u8FD4\u56DE needs_owner\u3002" : "";
  return `\u7ED3\u6784\u5316\u7ED3\u679C\u7528 \`submit_review_result\` \u5DE5\u5177\u63D0\u4EA4\uFF08\u5DE5\u5177\u5F53\u573A\u6821\u9A8C\uFF0C\u8FD4\u56DE\u9519\u8BEF\u65F6\u4FEE\u6B63\u540E\u518D\u63D0\u4EA4\uFF09\uFF1B\u8FD4\u56DE ok:true \u5373\u4EA4\u4ED8\u5B8C\u6210\uFF0C\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E gate \u4E0E\u7ED3\u8BBA\u3002
\u5DE5\u5177\u4E0D\u53EF\u7528\u65F6\uFF0C\u6700\u7EC8\u56DE\u590D\u6309\u516D\u8282\u5199\uFF0C\u5E76\u5728 \`## \u4E8B\u5B9E\u4E0E\u8BC1\u636E\` \u653E\u4E00\u4E2A \`json review_result_v1\` \u4EE3\u7801\u5757\uFF1A
{"schema_version":1,"gate":"pass | fail | needs_owner","summary":"\u4E00\u53E5\u7ED3\u8BBA","findings":[],"evidence_gaps":[],"scope":{"reviewed":${reviewedExample},"not_reviewed":[]${actualReadsField}},"output":{}}
${coverageHint}${actualReadsHint}\u6700\u7EC8\u53EA\u8FD4\u56DE\u7ED3\u6784\u5316\u7ED3\u679C\uFF1B\u62A5\u544A\u6B63\u6587\u548C FINAL_HANDOFF \u7531 runner \u673A\u68B0\u751F\u6210\u3002
`;
}
function structuredReview(pkg) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  return STRUCTURED_PROFILES.has(review.profile);
}
function reviewPackageProjection(pkg) {
  if (!structuredReview(pkg)) return pkg;
  const runtime = isRecord(pkg?.runtime_context) ? pkg.runtime_context : {};
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  return {
    version: orNull(pkg.version),
    package_id: orNull(pkg.package_id),
    agent: {
      role: orNull(agent.role),
      runtime_role: orNull(agent.runtime_role),
      capability: orNull(agent.capability),
      required_files: orNull(agent.required_files)
    },
    goal: orNull(pkg.goal),
    scope: orNull(pkg.scope),
    tool_contract: orNull(pkg.tool_contract),
    expected_output: orNull(pkg.expected_output),
    runtime_context: {
      cwd: orNull(runtime.cwd),
      output_root: orNull(runtime.output_root),
      target_repo: orNull(runtime.target_repo)
    },
    extensions: {
      ...isRecord(extensions.model_config) ? { model_config: extensions.model_config } : {},
      capability_contract: orNull(extensions.capability_contract),
      review_execution: orNull(extensions.review_execution),
      review_evidence: orNull(extensions.review_evidence)
    },
    handoff_contract: orNull(pkg.handoff_contract)
  };
}
function* scopeFiles(target, missingPaths) {
  if (isFile3(target)) {
    yield target;
    return;
  }
  let directory;
  try {
    directory = opendirSync2(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    missingPaths.push(target);
    return;
  }
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      const child = path12.join(target, entry.name);
      if (entry.isDirectory()) yield* scopeFiles(child, missingPaths);
      else if (isFile3(child)) yield child;
    }
  } finally {
    directory.closeSync();
  }
}
function runtimeMaterial(pkg, requiredFiles) {
  const agent = isRecord(pkg) ? pkg.agent : {};
  const capability = isRecord(agent) ? agent.capability : {};
  const commonPath = "ops/agent-prompts/_common.md";
  const capabilityPath = isRecord(capability) ? pyStr(pyOr(capability.file, "")) : "";
  const byPath = new Map(requiredFiles.map((item) => [item.path, item.content]));
  const compactReview = structuredReview(pkg);
  const supportFiles = requiredFiles.filter((item) => item.path !== commonPath && item.path !== capabilityPath);
  const evidence = reviewEvidenceSupport(pkg);
  if (evidence !== null) supportFiles.push(evidence);
  const omittedScopeFiles = [];
  if (inlinesScopeRead(pkg)) {
    let remaining = REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET;
    const base = pyStr(pyOr(pkg.runtime_context?.target_repo, ROOT));
    for (const item of filledList(pkg.scope?.read)) {
      const target = path12.resolve(base, pyStr(item));
      const missingPaths = [];
      for (const file of scopeFiles(target, missingPaths)) {
        const shown = path12.relative(base, file).replaceAll("\\", "/");
        const bytes = statSync8(file).size;
        if (bytes > remaining) {
          omittedScopeFiles.push({ path: shown, bytes });
          continue;
        }
        remaining -= bytes;
        supportFiles.push({ path: shown, heading: `\u5377\u5B97\uFF1A${shown}`, content: pyReadText(file) });
      }
      for (const missing of missingPaths) {
        omittedScopeFiles.push({ path: path12.relative(base, missing).replaceAll("\\", "/"), missing: true });
      }
    }
  }
  return {
    schema_version: 3,
    task_package: reviewPackageProjection(pkg),
    common_prompt: {
      path: commonPath,
      content: byPath.has(commonPath) ? byPath.get(commonPath) : ""
    },
    capability_prompt: {
      path: capabilityPath,
      content: byPath.has(capabilityPath) ? byPath.get(capabilityPath) : ""
    },
    support_files: supportFiles,
    omitted_scope_files: omittedScopeFiles,
    output_template: compactReview ? { format: "review_result_v1", content: outputTemplateFor(pkg) } : null
  };
}
function contains(collection, value) {
  if (collection instanceof Set) return collection.has(value);
  if (Array.isArray(collection)) return collection.includes(value);
  return false;
}
function renderedMaterialBody(item, requiredPaths) {
  const content = pyStr(pyOr(item?.content, ""));
  const itemPath = pyStr(pyOr(item?.path, ""));
  if (!contains(requiredPaths, itemPath)) return [content];
  const marker = JSON.stringify({ path: itemPath });
  return [
    `<!-- subagent-required-material:start ${marker} -->`,
    content,
    "<!-- subagent-required-material:end -->"
  ];
}
function jsonBlock(value) {
  return `\`\`\`json
${JSON.stringify(value, null, 2)}
\`\`\``;
}
function inlinesScopeRead(pkg) {
  const allowed = isRecord(pkg?.tool_contract) ? pkg.tool_contract.allowed : null;
  return Array.isArray(allowed) && !allowed.some((name) => pyStrip(pyStr(name)) === "read") && !structuredReview(pkg);
}
function filledList(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== void 0 && pyStrip(pyStr(item)) !== "") : [];
}
function renderTaskCard(pkg, packagePath = "", omittedScopeFiles = []) {
  const scope = isRecord(pkg?.scope) ? pkg.scope : {};
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const expected = isRecord(pkg?.expected_output) ? pkg.expected_output : {};
  const tools = isRecord(pkg?.tool_contract) ? pkg.tool_contract : {};
  const alignment = isRecord(pkg?.alignment) ? pkg.alignment : {};
  const goal = pyStrip(pyStr(pyOr(pkg?.goal, "")));
  const lines = ["## \u4EFB\u52A1\u5361", ""];
  lines.push(packagePath ? `\u4EFB\u52A1\u5305 \`${pyStr(pkg?.package_id)}\`\uFF1B\u5B8C\u6574 JSON \u5728 \`${packagePath}\`\uFF0C\u80FD\u529B\u89C4\u5219\u91CC\u7684 \`task_package.*\` \u5B57\u6BB5\u90FD\u5728\u5176\u4E2D\u3002` : `\u4EFB\u52A1\u5305 \`${pyStr(pkg?.package_id)}\`\u3002`);
  lines.push("", "### \u76EE\u6807", goal);
  const inputs = isRecord(pkg?.inputs) ? Object.fromEntries(Object.entries(pkg.inputs).filter(([key, value]) => !(key === "question" && pyStrip(pyStr(value)) === goal))) : {};
  if (Object.keys(inputs).length) lines.push("", "### \u8F93\u5165", jsonBlock(inputs));
  const readLabel = inlinesScopeRead(pkg) ? omittedScopeFiles.length ? "\u5FC5\u8BFB\uFF08\u90E8\u5206\u5168\u6587\u5DF2\u5728\u4E0A\u6587\u300C\u5377\u5B97\u300D\u5404\u8282\uFF0C\u672A\u5185\u8054\u9879\u89C1\u4E0B\uFF09" : "\u5FC5\u8BFB\uFF08\u5168\u6587\u5DF2\u5728\u4E0A\u6587\u300C\u5377\u5B97\u300D\u5404\u8282\uFF09" : "\u5FC5\u8BFB";
  const scopeRows = [[readLabel, scope.read], ["\u53EF\u5199", scope.write], ["\u53EF\u5220", scope.delete], ["\u4E0D\u505A", scope.out_of_scope]].map(([label, value]) => [label, filledList(value)]).filter(([, items]) => items.length);
  lines.push("", "### \u8303\u56F4", ...scopeRows.length ? scopeRows.map(([label, items]) => `- ${label}\uFF1A${items.map((item) => `\`${pyStr(item)}\``).join("\u3001")}`) : ["- \u672A\u58F0\u660E"]);
  const budgetOmissions = omittedScopeFiles.filter((item) => !item.missing);
  const missingOmissions = omittedScopeFiles.filter((item) => item.missing);
  if (budgetOmissions.length) {
    lines.push(
      `- \u672A\u5185\u8054\uFF08\u5377\u5B97\u5168\u6587\u9884\u7B97 ${REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET} \u5B57\u8282\uFF09\uFF1A`,
      ...budgetOmissions.map((item) => `  - \`${item.path}\`\uFF1A${item.bytes} \u5B57\u8282`)
    );
  }
  if (missingOmissions.length) {
    lines.push(
      "- \u7F3A\u5931\u7684\u5FC5\u8BFB\u8DEF\u5F84\uFF08\u672A\u5185\u8054\uFF09\uFF1A",
      ...missingOmissions.map((item) => `  - \`${item.path}\``)
    );
  }
  const facts = filledList(pkg?.known_facts);
  if (facts.length) lines.push("", "### \u5DF2\u77E5\u4E8B\u5B9E", ...facts.map((item) => `- ${pyStr(item)}`));
  if (isRecord(extensions.capability_contract) && Object.keys(extensions.capability_contract).length) {
    lines.push("", "### \u80FD\u529B\u5408\u540C", jsonBlock(extensions.capability_contract));
  }
  for (const [key, label] of [["review_execution", "\u5BA1\u67E5\u6267\u884C"], ["review_evidence", "\u5BA1\u67E5\u8BC1\u636E"]]) {
    if (isRecord(extensions[key]) && Object.keys(extensions[key]).length) lines.push("", `### ${label}`, jsonBlock(extensions[key]));
  }
  const outputRows = [];
  const reportPath = pyStr(pyOr(expected.resolved_file_path, expected.file_path, ""));
  if (reportPath) outputRows.push(`- \u62A5\u544A\uFF1A\`${reportPath}\``);
  const sections = filledList(expected.required_sections);
  if (sections.length) outputRows.push(`- \u62A5\u544A\u7AE0\u8282\uFF1A${sections.map((item) => pyStr(item)).join("\u3001")}`);
  const gate = pyStrip(pyStr(pyOr(expected.business_gate, "")));
  if (gate) outputRows.push(`- \u4E1A\u52A1\u95E8\uFF1A\`${gate}\``);
  if (outputRows.length) lines.push("", "### \u4EA7\u7269", ...outputRows);
  const toolRows = [];
  const declaredOnly = !isRecord(pkg?.worker_resources) || Array.isArray(pkg.worker_resources.declared_tools);
  if (Array.isArray(tools.allowed) && declaredOnly) toolRows.push(`- \u53EA\u7528\uFF1A${tools.allowed.length ? tools.allowed.join("\u3001") : "\u65E0"}`);
  const forbidden = filledList(tools.forbidden);
  if (forbidden.length) toolRows.push(`- \u7981\u7528\uFF1A${forbidden.map((item) => pyStr(item)).join("\u3001")}`);
  toolRows.push(`- \u8054\u7F51\uFF1A${tools.network_allowed === true ? "\u5141\u8BB8" : "\u4E0D\u5141\u8BB8"}\uFF1B\u5B89\u88C5\u4F9D\u8D56\uFF1A${tools.install_allowed === true ? "\u5141\u8BB8" : "\u4E0D\u5141\u8BB8"}`);
  lines.push("", "### \u5DE5\u5177", ...toolRows);
  if (isRecord(alignment.guard) && alignment.guard.required === true) lines.push("", "### \u5BF9\u9F50\u5B88\u536B", jsonBlock(alignment));
  const stops = filledList(pkg?.stop_conditions);
  if (stops.length) lines.push("", "### \u505C\u6B62\u6761\u4EF6", ...stops.map((item) => `- ${pyStr(item)}`));
  return lines.join("\n");
}
function renderFullTaskMaterial(material, packagePath = "") {
  const pkg = material?.task_package;
  const common = isRecord(material?.common_prompt) ? material.common_prompt : {};
  const capability = isRecord(material?.capability_prompt) ? material.capability_prompt : {};
  const output = isRecord(material?.output_template) ? material.output_template : {};
  const supportFiles = Array.isArray(material?.support_files) ? material.support_files : [];
  const agent = isRecord(pkg) && isRecord(pkg.agent) ? pkg.agent : {};
  const required = Array.isArray(agent.required_files) ? agent.required_files : [];
  const requiredPaths = new Set(required.map((item) => pyStr(item)));
  const goal = pyStrip(pyStr(pyOr(pkg?.goal, "")));
  const headline = goal.split("\n")[0];
  const parts = [
    `\u672C\u6B21\u4EFB\u52A1\uFF1A${headline}`,
    "\u5B8C\u6574\u4EFB\u52A1\u5361\u5728\u672C\u6587\u672B\u5C3E\u7684\u300C\u4EFB\u52A1\u5361\u300D\u4E00\u8282\u3002\u5148\u8BFB\u4E0B\u9762\u7684\u89C4\u5219\uFF0C\u518D\u6309\u4EFB\u52A1\u5361\u6267\u884C\u3002",
    "",
    "## \u516C\u5171\u89C4\u5219",
    ...renderedMaterialBody(common, requiredPaths),
    "",
    "## \u80FD\u529B\u89C4\u5219",
    ...renderedMaterialBody(capability, requiredPaths)
  ];
  for (const item of supportFiles) {
    if (!isRecord(item)) continue;
    const content = item.content;
    if (typeof content === "string" && content) {
      parts.push("", `## ${pyStr(pyOr(item.heading, "\u8865\u5145\u6750\u6599"))}`, ...renderedMaterialBody(item, requiredPaths));
    }
  }
  parts.push("", renderTaskCard(pkg, packagePath, material.omitted_scope_files ?? []));
  if (output.content) parts.push("", "## \u7ED3\u6784\u5316\u7ED3\u679C", pyStr(output.content));
  return pyStrip(parts.join("\n"));
}
function renderDirectTaskMaterial(pkg, packagePath = "") {
  const requiredFiles = readRequiredFiles(pkg);
  const material = runtimeMaterial(pkg, requiredFiles);
  return renderFullTaskMaterial(material, packagePath);
}
function renderTaskMaterialFile(packagePath) {
  return renderDirectTaskMaterial(loadPackage(packagePath), path12.resolve(packagePath));
}
var REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET, STRUCTURED_PROFILES;
var init_subagent_preload = __esm({
  "ops/tools/dispatch-core/subagent_preload.mjs"() {
    init_tool_common();
    init_py();
    REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET = 2e5 * 4;
    STRUCTURED_PROFILES = /* @__PURE__ */ new Set(["evidence_only_v1", "semantic_review_v2", "acceptance_synthesis_v1"]);
  }
});

// ops/tools/dispatch-core/task_package_lint.mjs
import { existsSync as existsSync6, statSync as statSync9 } from "node:fs";
function dictGet(container, key, fallback = void 0) {
  if (!isRecord(container)) throw pyError("AttributeError", `'${pyTypeName(container)}' object has no attribute 'get'`);
  return Object.hasOwn(container, key) ? container[key] : fallback;
}
function sameStringList(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}
function existsUnderRoot(value, root) {
  return existsSync6(pathlibJoin(root, value));
}
function isExternalRef(value) {
  return EXTERNAL_REF_RE.test(value) || value.startsWith("http://") || value.startsWith("https://");
}
function targetRoot(pkg) {
  const issues = [];
  const runtime = dictGet(pkg, "runtime_context", {});
  const target = isRecord(runtime) ? pyGet(runtime, "target_repo") : null;
  const createAllowed = isRecord(runtime) ? pyGet(runtime, "target_repo_create_allowed") === true : false;
  if (target === null || target === void 0 || target === "") return [resolveLikePython(ROOT), issues];
  if (typeof target !== "string" || !target.trim()) {
    return [resolveLikePython(ROOT), ["runtime_context.target_repo must be a non-empty string when set"]];
  }
  if (!isAbsoluteLikePython(target)) issues.push("runtime_context.target_repo must be an absolute path");
  const resolved = pyResolveUnder(target, ROOT);
  if (!existsSync6(resolved) && !createAllowed) {
    issues.push(`runtime_context.target_repo not found: ${target}`);
  } else if (existsSync6(resolved) && !statSync9(resolved).isDirectory()) {
    issues.push(`runtime_context.target_repo is not a directory: ${target}`);
  }
  return [resolved, issues];
}
function pathScopeIssue(value, { base, rootLabel, allowAbsoluteOutside = false, allowRuntime = false } = {}) {
  if (isExternalRef(value)) return null;
  const resolved = pyResolveUnder(value, base);
  if (isAbsoluteLikePython(value) && allowAbsoluteOutside) return null;
  if (allowRuntime && pyRelativeTo(lexicalAbsolute(pathlibJoin(base, value)), resolveLikePython(base)) !== null && isSameOrInside(resolved, RUNTIME_ROOT)) return null;
  if (pyRelativeTo(resolved, resolveLikePython(base)) === null) {
    return `path is outside ${rootLabel} scope: ${value}`;
  }
  return null;
}
function routeProfile2(pkg) {
  const agent = dictGet(pkg, "agent", {});
  const capability = dictGet(agent, "capability", {});
  const routeId2 = routeIdFromAgent(pyStr(dictGet(agent, "role", "")), pyStr(dictGet(capability, "name", "")));
  return [routeId2, profileFor(routeId2)];
}
function lintAgent(pkg, profile, routeId2, { compiled = false } = {}) {
  const issues = [];
  const agent = dictGet(pkg, "agent", {});
  const capability = dictGet(agent, "capability", {});
  const expectedAgent = pyGetItem(profile, "agent");
  if (!compiled) {
    if (dictGet(agent, "role") !== pyGetItem(expectedAgent, "role")) issues.push(`agent.role mismatch for ${routeId2}`);
    if (dictGet(agent, "runtime_role") !== pyGetItem(expectedAgent, "runtime_role")) {
      issues.push(`agent.runtime_role mismatch for ${routeId2}`);
    }
    if (dictGet(capability, "name") !== pyGetItem(pyGetItem(expectedAgent, "capability"), "name")) {
      issues.push(`capability.name mismatch for ${routeId2}`);
    }
    if (dictGet(capability, "file") !== pyGetItem(pyGetItem(expectedAgent, "capability"), "file")) {
      issues.push(`capability.file mismatch for ${routeId2}`);
    }
  }
  const requiredFiles = asList(dictGet(agent, "required_files"));
  const expectedRequiredFiles = conditionalRequiredFiles(pkg, profile);
  if (!compiled && !sameStringList(requiredFiles, expectedRequiredFiles)) issues.push(`agent.required_files mismatch for ${routeId2}`);
  for (const item of expectedRequiredFiles) {
    if (!existsUnderRoot(item, RUNTIME_ROOT)) issues.push(`agent.required_files path missing from runtime: ${item}`);
  }
  if (!requiredFiles.includes("ops/agent-prompts/_common.md")) {
    issues.push("agent.required_files missing ops/agent-prompts/_common.md");
  }
  const capabilityFile = pyGetItem(pyGetItem(expectedAgent, "capability"), "file");
  if (!requiredFiles.includes(capabilityFile)) {
    issues.push(`agent.required_files missing capability prompt ${capabilityFile}`);
  }
  if (!existsUnderRoot(pyGetItem(profile, "route_file"), RUNTIME_ROOT)) {
    issues.push(`route file missing: ${pyGetItem(profile, "route_file")}`);
  }
  return issues;
}
function lintScope(pkg) {
  const issues = [];
  const scope = dictGet(pkg, "scope", {});
  if (!isRecord(scope)) return ["scope must be an object"];
  const [root, rootIssues] = targetRoot(pkg);
  issues.push(...rootIssues);
  const rootLabel = !pySamePath(root, resolveLikePython(ROOT)) ? "target_repo" : "repository";
  for (const key of ["read", "write", "delete", "out_of_scope"]) {
    if (!Array.isArray(dictGet(scope, key))) issues.push(`scope.${key} must be a list`);
  }
  for (const item of asList(dictGet(scope, "read"))) {
    if (typeof item !== "string") {
      issues.push("scope.read entries must be strings");
      continue;
    }
    const issue = pathScopeIssue(item, { base: root, rootLabel, allowAbsoluteOutside: true, allowRuntime: true });
    if (issue) issues.push(issue);
  }
  for (const key of ["write", "delete"]) {
    for (const item of asList(dictGet(scope, key))) {
      if (typeof item !== "string") {
        issues.push(`scope.${key} entries must be strings`);
        continue;
      }
      if (isExternalRef(item)) {
        issues.push(`scope.${key} cannot be external ref: ${item}`);
        continue;
      }
      let issue = pathScopeIssue(item, { base: ROOT, rootLabel: "repository", allowAbsoluteOutside: false });
      if (issue && key === "write" && !pySamePath(root, resolveLikePython(ROOT))) {
        const targetIssue = pathScopeIssue(item, { base: root, rootLabel, allowAbsoluteOutside: false });
        if (targetIssue === null) issue = null;
      }
      if (issue) issues.push(issue);
    }
  }
  for (const item of asList(dictGet(scope, "out_of_scope"))) {
    if (typeof item !== "string") issues.push("scope.out_of_scope entries must be strings");
  }
  return issues;
}
function lintExpectedOutput(pkg) {
  const issues = [];
  const expected = dictGet(pkg, "expected_output", {});
  if (!isRecord(expected)) return ["expected_output must be an object"];
  const mode = dictGet(expected, "mode");
  const [root, rootIssues] = targetRoot(pkg);
  issues.push(...rootIssues);
  issues.push(...checkExpectedOutputContract(expected));
  const resolved = dictGet(expected, "resolved_file_path", null);
  if (mode === "file" && resolved !== null && resolved !== void 0 && pyTruthy(dictGet(expected, "file_path"))) {
    const repoIssue = pathScopeIssue(pyStr(resolved), { base: ROOT, rootLabel: "repository" });
    const targetIssue = pathScopeIssue(pyStr(resolved), { base: root, rootLabel: "target_repo" });
    if (repoIssue && targetIssue) {
      issues.push("expected_output.resolved_file_path must be under repository root or runtime_context.target_repo");
    }
  }
  return issues;
}
function lintCommonObjects(pkg) {
  const issues = [];
  for (const key of [
    "project_positioning",
    "ownership",
    "concurrency_contract",
    "inputs",
    "runtime_context",
    "alignment",
    "planning_policy",
    "tool_contract",
    "extensions",
    "handoff_contract"
  ]) {
    if (!isRecord(dictGet(pkg, key))) issues.push(`${key} must be an object`);
  }
  for (const key of ["known_facts", "stop_conditions"]) {
    if (!Array.isArray(dictGet(pkg, key))) issues.push(`${key} must be a list`);
  }
  const toolContract = dictGet(pkg, "tool_contract", {});
  const allowed = isRecord(toolContract) ? pyGet(toolContract, "allowed", null) : null;
  if (allowed !== null && allowed !== void 0) {
    if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !item.trim())) {
      issues.push("tool_contract.allowed must be null or an array of non-empty Pi tool names");
    }
  }
  for (const field of ["network_allowed", "install_allowed"]) {
    if (isRecord(toolContract) && Object.hasOwn(toolContract, field) && typeof toolContract[field] !== "boolean") {
      issues.push(`tool_contract.${field} must be boolean`);
    }
  }
  const handoff = dictGet(pkg, "handoff_contract", {});
  issues.push(...checkHandoffContract(handoff));
  const handoffFile = dictGet(handoff, "handoff_file");
  const resolvedHandoff = dictGet(handoff, "resolved_handoff_file", null);
  if (resolvedHandoff !== null && resolvedHandoff !== void 0 && pyTruthy(handoffFile)) {
    if (pathScopeIssue(pyStr(resolvedHandoff), { base: ROOT, rootLabel: "repository" })) {
      issues.push("handoff_contract.resolved_handoff_file must be under repository root");
    }
  }
  return issues;
}
function lintCapabilityContract(pkg, routeId2) {
  const issues = [];
  const contracts = dictGet(dictGet(pkg, "extensions", {}), "capability_contract", {});
  if (!isRecord(contracts)) return issues;
  if (routeId2 === "executor-agent__scoped-execution") {
    const scoped = dictGet(dictGet(contracts, "executor", {}), "scoped", {});
    if (isRecord(scoped)) {
      const operationType = pyStr(pyOr(pyGet(scoped, "operation_type"), "")).trim();
      const refResolution = pyGet(scoped, "ref_resolution");
      const resolution = isRecord(refResolution) ? refResolution : {};
      const ifMissing = pyStr(pyOr(pyGet(resolution, "if_missing"), "")).trim();
      const fallbackRef = pyGet(resolution, "fallback_ref", null);
      const fallbackPresent = typeof fallbackRef === "string" && Boolean(fallbackRef.trim());
      if (operationType === "source_clone_only" && ifMissing === "fallback_default_branch") {
        if (!fallbackPresent) {
          issues.push(
            "executor.scoped.ref_resolution.fallback_ref must be a non-empty string when if_missing=fallback_default_branch"
          );
        }
      }
    }
  }
  if (routeId2 === "executor-agent__plan-execution") {
    const executor = dictGet(contracts, "executor", {});
    if (isRecord(executor)) {
      const policy = pyGet(executor, "execution_adjustment_policy", {});
      if (isRecord(policy) && Object.hasOwn(policy, "allowed_kinds") && (!Array.isArray(policy.allowed_kinds) || policy.allowed_kinds.some((kind) => !PLAN_EXECUTION_ADJUSTMENT_KINDS.includes(kind)))) {
        issues.push("executor.execution_adjustment_policy.allowed_kinds must be a subset of the supported adjustment kinds");
      }
      const locks = pyGet(executor, "resource_locks");
      if (Array.isArray(locks)) {
        locks.forEach((lock, index) => {
          const prefix = `executor.resource_locks[${index}]`;
          if (!isRecord(lock)) {
            issues.push(`${prefix} must be an object`);
            return;
          }
          for (const field of ["lock_id", "holder_lane"]) {
            const value = pyGet(lock, field);
            if (typeof value !== "string" || !value.trim()) {
              issues.push(`${prefix}.${field} must be a non-empty string`);
            }
          }
          const releaseEvents = pyGet(lock, "release_events");
          if (!Array.isArray(releaseEvents) || pyGet(lock, "exclusive") === true && !releaseEvents.length || asList(releaseEvents).some((event) => !RESOURCE_RELEASE_EVENTS.has(event))) {
            issues.push(`${prefix}.release_events must use observable release events`);
          }
        });
      }
    }
  }
  if (routeId2 === "batch-agent__mechanical-batch") {
    const batch = dictGet(contracts, "batch", {});
    if (isRecord(batch) && Object.hasOwn(batch, "chunk_budget")) {
      const budget = pyGet(batch, "chunk_budget");
      for (const field of ["max_files", "max_bytes", "max_lines"]) {
        const value = isRecord(budget) ? pyGet(budget, field, null) : null;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          issues.push(`batch.chunk_budget.${field} must be a positive integer`);
        }
      }
    }
  }
  return issues;
}
function lintPackage(root, { compiled = false } = {}) {
  const pkg = pyGetItem(root, "task_package");
  const issues = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(isRecord(pkg) ? Object.hasOwn(pkg, key) : false)) issues.push(`missing top-level field: ${key}`);
  }
  let routeId2;
  let profile;
  try {
    [routeId2, profile] = routeProfile2(pkg);
  } catch (error) {
    if (error?.name === "KeyError") return [error.message];
    throw error;
  }
  issues.push(...lintAgent(pkg, profile, routeId2, { compiled }));
  issues.push(...lintScope(pkg));
  issues.push(...lintExpectedOutput(pkg));
  issues.push(...lintCommonObjects(pkg));
  issues.push(...lintCapabilityContract(pkg, routeId2));
  return issues;
}
var EXTERNAL_REF_RE, RESOURCE_RELEASE_EVENTS;
var init_task_package_lint = __esm({
  "ops/tools/dispatch-core/task_package_lint.mjs"() {
    init_tool_common();
    init_py();
    init_task_package_build();
    init_task_package_profiles();
    EXTERNAL_REF_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
    RESOURCE_RELEASE_EVENTS = /* @__PURE__ */ new Set(["contract_locked", "execution_done", "validation_passed"]);
  }
});

// ops/tools/pi_model_extension_profile.mjs
import { existsSync as existsSync7 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path13 from "node:path";
function resolvePiAgentDir(env = process.env) {
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  return path13.resolve(configured || path13.join(homedir2(), ".pi", "agent"));
}
function resolvePiChildModelExtensions(options = {}) {
  const env = options.env || process.env;
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync7;
  const agentDir = path13.resolve(options.agentDir || resolvePiAgentDir(env));
  return RELATIVE_EXTENSION_PATHS.map((relativePath) => path13.join(agentDir, ...relativePath.split("/"))).filter((candidate) => exists(candidate));
}
function isPiModelExtensionProfileCli(argv1 = process.argv[1]) {
  return path13.basename(String(argv1 || "")).toLowerCase() === "pi_model_extension_profile.mjs";
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
import { existsSync as existsSync8, mkdirSync as mkdirSync6, readFileSync as readFileSync8, statSync as statSync10, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import path14 from "node:path";
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
  const file = path14.join(dir, "package.json");
  if (!existsSync8(file)) return null;
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
  agentDir = process.env.PI_CODING_AGENT_DIR || path14.join(homedir3(), ".pi", "agent"),
  piCli = PI_CLI
} = {}) {
  const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL(path14.join(path14.dirname(piCli), "index.js")).href);
  const settingsPath = path14.join(agentDir, "settings.json");
  const settings = existsSync8(settingsPath) ? JSON.parse(readFileSync8(settingsPath, "utf8")) : {};
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
  const key = JSON.stringify(["registration-only/v1", path14.resolve(cwd), ...[piCli, ...extensions.map((item) => item.path)].map((file) => [file, existsSync8(file) ? statSync10(file).mtimeMs : 0])]);
  const cached = existsSync8(cacheFile) ? JSON.parse(readFileSync8(cacheFile, "utf8")) : null;
  if (cached?.key === key) return Promise.resolve(cached.tools);
  const id = `${cacheFile}
${key}`;
  if (!probes.has(id)) {
    probes.set(id, runToolProbe(extensions, piCli, cwd).then((tools) => {
      mkdirSync6(path14.dirname(cacheFile), { recursive: true });
      writeFileSync4(cacheFile, JSON.stringify({ key, tools }));
      return tools;
    }).finally(() => probes.delete(id)));
  }
  return probes.get(id);
}
function runToolProbe(extensions, piCli, cwd) {
  const loader = path14.join(path14.dirname(piCli), "core", "extensions", "loader.js");
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
  toolCache = path14.join(cwd, ".runtime", "cockpit", "worker-tool-probe.json"),
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
function defaultOnTools(config) {
  return Object.keys(config.tools).filter((name) => config.tools[name].access === "default_on" && !config.required_tools.includes(name));
}
var WORKER_RESOURCES_CONFIG, IMPORT_ACCESS, BUILTIN_TOOLS, RUNNER_TOOLS, PI_CLI, PROBE_TIMEOUT_MS, PROBE_SCRIPT, probes, SECTIONS, ENTRY_KEYS, REMOVED_KEYS;
var init_pi_worker_resources = __esm({
  async "ops/tools/pi_worker_resources.mjs"() {
    WORKER_RESOURCES_CONFIG = path14.resolve(path14.dirname(fileURLToPath2(import.meta.url)), "../templates/worker-resources.json");
    IMPORT_ACCESS = Object.freeze(["off", "optional", "default_on"]);
    BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
    RUNNER_TOOLS = Object.freeze(["research_search", "research_fetch", "command_job"]);
    PI_CLI = path14.join(process.env.APPDATA || path14.join(homedir3(), "AppData", "Roaming"), "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
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
    if (path14.basename(process.argv[1] || "") === "pi_worker_resources.mjs") {
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

// ops/tools/dispatch_prepare.selftest.mjs
var dispatch_prepare_selftest_exports = {};
__export(dispatch_prepare_selftest_exports, {
  SELF_TEST_CHILD_CATALOG: () => SELF_TEST_CHILD_CATALOG,
  selfTest: () => selfTest
});
import { spawnSync as spawnSync5 } from "node:child_process";
import { existsSync as existsSync9, mkdirSync as mkdirSync7, mkdtempSync, readFileSync as readFileSync9, readdirSync as readdirSync6, rmSync as rmSync4, statSync as statSync11, writeFileSync as writeFileSync5 } from "node:fs";
import os2 from "node:os";
import path15 from "node:path";
import process7 from "node:process";
function timeNs() {
  return `${BigInt(Date.now()) * 1000000n + process7.hrtime.bigint() % 1000000n}`;
}
function isFile4(target) {
  try {
    return statSync11(target).isFile();
  } catch {
    return false;
  }
}
function isDir(target) {
  try {
    return statSync11(target).isDirectory();
  } catch {
    return false;
  }
}
function readText(target) {
  return readFileSync9(target, "utf8");
}
function deepEqual(left, right) {
  return JSON.stringify(dpCanonical(left)) === JSON.stringify(dpCanonical(right));
}
function dpCanonical(value) {
  if (Array.isArray(value)) return value.map(dpCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, dpCanonical(value[key])]));
  }
  return value;
}
function selfTest() {
  const original = deps.probePiChildModelCatalogUncached;
  deps.probePiChildModelCatalogUncached = () => structuredClone(SELF_TEST_CHILD_CATALOG);
  clearModelCatalogCache();
  try {
    return runSelfTestChecks();
  } finally {
    deps.probePiChildModelCatalogUncached = original;
    clearModelCatalogCache();
  }
}
function runSelfTestChecks() {
  const seed = sampleSeed("general-agent__general-default");
  const tempPaths = [];
  const isolatedSubmissions = [];
  const catalog = projectCatalog(selectionConfig, { piModels: configuredModels });
  const resolveFor = (role, capability, options = {}) => resolveSelection(selectionConfig, { role, capability, ...options });
  const everyPickResolvesToItsRow = catalog.roles.every((role) => role.capabilities.every((capability) => projectCatalog(selectionConfig, {
    role: role.role,
    capability: capability.id
  }).roles[0].picks.every((pick) => {
    const resolved = resolveFor(role.role, capability.id, { pick: pick.id });
    return resolved.resolved_model === pick.model && resolved.resolved_effort === pick.effort && resolved.effort_range.join() === [pick.effort_min, pick.effort_max].join();
  })));
  const isolatedSubmitter = (operation, args) => {
    if (operation !== "submit-prepared") throw new ToolError2(`unsupported self-test adapter operation: ${operation}`);
    const dispatchFile = path15.resolve(String(args?.dispatch_file || ""));
    const controlledRoot = path15.resolve(path15.join(ROOT2, "tmp", "dispatch_prepare"));
    if (!pyIsRelativeTo(dispatchFile, controlledRoot)) {
      throw new ToolError2("self-test dispatch envelope escaped tmp/dispatch_prepare");
    }
    const envelope = pyJsonLoads(readText(dispatchFile));
    if (envelope.contract_version !== ASYNC_DISPATCH_CONTRACT_VERSION) {
      throw new ToolError2("self-test dispatch envelope contract mismatch");
    }
    isolatedSubmissions.push(dispatchFile);
    return { ok: true, task_id: `async-self-test-${String(isolatedSubmissions.length).padStart(2, "0")}` };
  };
  const asyncRoot = path15.join(ROOT2, ".runtime", "self-tests", `dispatch-prepare-async-${timeNs()}`);
  const fakeRunner = path15.join(asyncRoot, "run-pi-task.mjs");
  mkdirSync7(path15.dirname(fakeRunner), { recursive: true });
  writeFileSync5(fakeRunner, [
    "import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "function value(name, fallback='') { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; }",
    "const outDir = value('--outDir');",
    "const taskFile = value('--taskFile');",
    "mkdirSync(outDir, { recursive: true });",
    "const taskText = readFileSync(taskFile, 'utf8');",
    "writeFileSync(path.join(outDir, 'report.md'), '# fake async dispatch report\\n\\n' + taskText.slice(0, 200) + '\\n', 'utf8');",
    "writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: fake async dispatch completed.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
    "writeFileSync(path.join(outDir, 'child-final.md'), '## \u7ED3\u8BBA\\npass\\n', 'utf8');",
    "writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done' }, null, 2), 'utf8');"
  ].join("\n"), "utf8");
  seed.scope.read = [String(fakeRunner)];
  const direct = prepareDirectPreview(seed);
  if (direct.task_package_path) tempPaths.push(path15.join(ROOT2, String(direct.task_package_path)));
  const renderedDirect = renderTaskMaterialFile(path15.join(ROOT2, String(direct.task_package_path)));
  const dryDirect = prepareDispatch(seed, "direct", { action: "preview" });
  const explicitAsyncPreview = prepareDispatch(seed, "async-subagent", { action: "preview" });
  const outputVisibilitySeed = exampleSeed("general-agent__general-default");
  if (!outputVisibilitySeed.scope) outputVisibilitySeed.scope = {};
  outputVisibilitySeed.scope.read = [String(fakeRunner)];
  if (!outputVisibilitySeed.scope.write_extra) outputVisibilitySeed.scope.write_extra = [];
  outputVisibilitySeed.scope.write_extra.push("notes/reports/dispatch-output-visibility-self-test.md");
  const outputVisibilityDry = prepareDispatch(expandSeed(outputVisibilitySeed), "direct", { action: "preview" });
  const scopeWriteDedupeSeed = exampleSeed("general-agent__general-default");
  scopeWriteDedupeSeed.slug = "dispatch-scope-write-dedupe-self-test";
  if (!scopeWriteDedupeSeed.scope) scopeWriteDedupeSeed.scope = {};
  scopeWriteDedupeSeed.scope.read = [String(fakeRunner)];
  if (!scopeWriteDedupeSeed.scope.write_extra) scopeWriteDedupeSeed.scope.write_extra = [];
  scopeWriteDedupeSeed.scope.write_extra.push("notes/general/dispatch-scope-write-dedupe-self-test.md");
  const scopeWriteDedupeDry = prepareDispatch(expandSeed(scopeWriteDedupeSeed), "direct", { action: "preview" });
  const scopeWriteDedupePaths = (scopeWriteDedupeDry.business_output || {}).scope_write || [];
  const explorerTemplate = renderTemplate("explorer-agent__codebase-scan");
  let directRuntimeBlocked = false;
  try {
    prepareDispatch(seed, "direct");
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    directRuntimeBlocked = String(error.message).includes("direct subagent dispatch is disabled");
  }
  const dispatchTmp = path15.join(ROOT2, "tmp", "dispatch_prepare");
  const evidenceTmp = path15.join(ROOT2, "tmp", "review_evidence");
  const fileNames = (dir) => existsSync9(dir) ? new Set(readdirSync6(dir).filter((name) => isFile4(path15.join(dir, name)))) : /* @__PURE__ */ new Set();
  const sameNames = (left, right) => left.size === right.size && [...left].every((name) => right.has(name));
  const beforeInvalidRoot = fileNames(dispatchTmp);
  const beforeInvalidEvidence = fileNames(evidenceTmp);
  const invalidRootSeed = expandSeed(exampleSeed("verify-agent__code-verification"));
  invalidRootSeed.scope.read = ["ops/tools/dispatch_prepare.mjs"];
  let invalidRootRejectedBeforeWrite = false;
  try {
    prepareDispatch(invalidRootSeed, "async-subagent", {
      asyncRunnerPath: fakeRunner,
      asyncTaskRoot: path15.join(path15.dirname(ROOT2), "outside-runtime")
    });
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    invalidRootRejectedBeforeWrite = String(error.message).includes("task_root must stay inside") && sameNames(beforeInvalidRoot, fileNames(dispatchTmp)) && sameNames(beforeInvalidEvidence, fileNames(evidenceTmp));
  }
  const asyncDispatch = prepareDispatch(seed, "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter
  });
  const auto = prepareDispatch(seed, "auto", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter
  });
  const readiness = asyncSubagentReadiness();
  const [endpointServer, endpointTool] = asyncSubagentEndpoint();
  const staleContractStatus = asyncDispatchContractStatus({ dispatch_contract_version: "async-dispatch/v1" });
  const compatibleContractStatus = asyncDispatchContractStatus({
    dispatch_contract_version: ASYNC_DISPATCH_CONTRACT_VERSION,
    supported_dispatch_contract_versions: ["async-dispatch/v1", ASYNC_DISPATCH_CONTRACT_VERSION]
  });
  const [staleDelivery] = resolveDeliveryWithReadiness(
    "async-subagent",
    { status: "unavailable", issues: [String(staleContractStatus.issue)] }
  );
  const checks = {
    list_roles_unique: catalog.roles.length > 0 && new Set(catalog.roles.map((row) => row.role)).size === catalog.roles.length,
    list_picks_have_ranges: catalog.roles.every((row) => row.picks.every((pick) => pick.id && pick.model && pick.effort_min && pick.effort_max)),
    list_phase_metadata_present: catalog.roles.every((row) => row.capabilities.every((cap) => cap.dispatch_phase?.kind)),
    list_models_have_efforts: catalog.models.every((row) => row.model && row.efforts.length > 0),
    list_picks_are_in_pi_catalog: catalog.warnings.length === 0,
    every_pick_resolves_to_its_row: everyPickResolvesToItsRow,
    direct_ok: direct.status === "ok",
    direct_mode: direct.delivery_mode === "direct_message",
    direct_file_ref_mode: direct.direct_payload_mode === "file_ref",
    direct_package_persisted: Boolean(direct.task_package_path) && isFile4(path15.join(ROOT2, String(direct.task_package_path))),
    direct_spawn_has_file_marker: direct.spawn_payload.includes("DIRECT_TASK_PACKAGE_FILE:"),
    direct_spawn_has_render_command: direct.spawn_payload.includes("subagent_preload.mjs render --package"),
    direct_spawn_omits_inline_material: !direct.spawn_payload.includes("## \u4EFB\u52A1\u5305"),
    async_ok: asyncDispatch.status === "ok",
    async_mode: asyncDispatch.delivery_mode === "async_subagent",
    async_has_task_id: Boolean(asyncDispatch.task_id),
    async_has_wait_tool_arguments: (asyncDispatch.wait_tool_arguments || {}).task_id === asyncDispatch.task_id,
    async_wait_has_no_revision_dependency: !Object.hasOwn(asyncDispatch.wait_tool_arguments || {}, "after_revision"),
    async_has_result_tool_arguments: (asyncDispatch.result_tool_arguments || {}).task_id === asyncDispatch.task_id,
    auto_ok: auto.status === "ok",
    auto_resolves_async_when_available: auto.resolved_delivery === "async-subagent",
    auto_has_readiness: auto.delivery_readiness.status === "available",
    auto_has_task_id: Boolean(auto.task_id),
    self_test_uses_isolated_submitter: Boolean(isolatedSubmissions.length) && isolatedSubmissions.every((item) => path15.resolve(path15.dirname(path15.dirname(item))) === path15.resolve(path15.join(ROOT2, "tmp", "dispatch_prepare", "preparations")) && path15.basename(path15.dirname(item)).startsWith("prep-")),
    readiness_auto_approves_async_tools: readiness.approval_mode === "approve",
    readiness_matches_dispatch_contract: readiness.dispatch_contract_version === ASYNC_DISPATCH_CONTRACT_VERSION && (readiness.supported_dispatch_contract_versions || []).includes(ASYNC_DISPATCH_CONTRACT_VERSION),
    stale_dispatch_contract_is_rejected: staleContractStatus.compatible === false && String(staleContractStatus.issue).includes(ASYNC_DISPATCH_CONTRACT_VERSION),
    compatible_dispatch_contract_is_accepted: compatibleContractStatus.compatible === true,
    explicit_async_delivery_uses_readiness: staleDelivery === "unavailable",
    readiness_and_submit_share_configured_endpoint: Boolean(endpointServer) && endpointTool !== null && endpointTool !== void 0 && readiness.tool_path === String(endpointTool),
    dry_run_ok: dryDirect.status === "ok" && dryDirect.dry_run === true,
    explicit_async_preview_skips_transport_readiness: explicitAsyncPreview.resolved_delivery === "async-subagent" && (explicitAsyncPreview.delivery_readiness || {}).status === "not_checked" && (explicitAsyncPreview.async_preview || {}).model === resolveFor("general-agent", "general-default").resolved_model,
    dry_run_no_spawn_hint: !dryDirect.spawn_payload.includes("SUBAGENT_TASK_ID"),
    dry_run_no_writes: deepEqual(dryDirect.writes_performed, []),
    dry_run_business_output_visible: Boolean((dryDirect.business_output || {}).expected_report_path),
    dry_run_write_extra_kept_separate: (outputVisibilityDry.business_output || {}).expected_report_path !== "notes/reports/dispatch-output-visibility-self-test.md" && ((outputVisibilityDry.business_output || {}).extra_write_paths || []).includes("notes/reports/dispatch-output-visibility-self-test.md"),
    business_output_scope_write_deduped: scopeWriteDedupePaths.filter((item) => item === "notes/general/dispatch-scope-write-dedupe-self-test.md").length === 1,
    direct_runtime_blocked: directRuntimeBlocked,
    invalid_task_root_rejected_before_write: invalidRootRejectedBeforeWrite
  };
  for (const rid of routesWithCards()) {
    try {
      const outcome = prepareDirectPreview(expandSeed(exampleSeed(rid)));
      if (outcome.task_package_path) tempPaths.push(path15.join(ROOT2, String(outcome.task_package_path)));
      checks[`card::${rid}`] = outcome.status === "ok";
    } catch (error) {
      if (!isPyCaughtError(error, /* @__PURE__ */ new Set(["ToolError", "KeyError", "ValueError"]))) throw error;
      checks[`card::${rid}`] = false;
    }
  }
  const codeTestingSeed = exampleSeed("verify-agent__code-verification");
  codeTestingSeed.contract.verify_mode = "testing";
  for (const key of ["changed_surfaces", "allowed_risk_triggers", "disallowed_topics", "issue_admission_required"]) {
    delete codeTestingSeed.contract[key];
  }
  try {
    expandSeed(codeTestingSeed);
    checks.code_testing_omits_verification_only_fields = true;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.code_testing_omits_verification_only_fields = false;
  }
  const codeVerificationSeed = exampleSeed("verify-agent__code-verification");
  delete codeVerificationSeed.contract.changed_surfaces;
  try {
    expandSeed(codeVerificationSeed);
    checks.code_verification_requires_changed_surfaces = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.code_verification_requires_changed_surfaces = String(error.message).includes("contract.changed_surfaces");
  }
  const plannerSeed = exampleSeed("planner-agent__plan-authoring");
  if (!plannerSeed.contract) plannerSeed.contract = {};
  delete plannerSeed.contract.locked_decisions;
  plannerSeed.contract.mechanical_schema = { interface_contract_kind_values: ["invented"] };
  plannerSeed.extensions = {
    capability_contract: {
      planner: { mechanical_schema: { source: "caller", interface_contract_kind_values: ["invented"] } }
    }
  };
  const plannerExpanded = expandSeed(plannerSeed);
  const plannerContract = ((plannerExpanded.extensions || {}).capability_contract || {}).planner || {};
  checks.planner_empty_locked_decisions_allowed = deepEqual(plannerContract.locked_decisions, []) && deepEqual((plannerExpanded.alignment || {}).decision_refs, []);
  checks.planner_mechanical_schema_injected_from_checker = (plannerContract.mechanical_schema || {}).source === "ops/tools/planning_manifest_check.py" && !((plannerContract.mechanical_schema || {}).interface_contract_kind_values || []).includes("invented") && ((plannerContract.mechanical_schema || {}).interface_contract_kind_values || []).includes("data_shape");
  const executorRootSeed = exampleSeed("executor-agent__plan-execution");
  executorRootSeed.contract.dependency_edges = [];
  executorRootSeed.contract.resource_locks = [];
  const executorRootExpanded = expandSeed(executorRootSeed);
  const executorRootContract = ((executorRootExpanded.extensions || {}).capability_contract || {}).executor || {};
  checks.executor_root_lane_empty_dependency_edges_allowed = deepEqual(executorRootContract.dependency_edges, []);
  checks.executor_lane_empty_resource_locks_allowed = deepEqual(executorRootContract.resource_locks, []);
  try {
    validatePlannerMechanicalSchema({ source: "ops/tools/planning_manifest_check.py" });
    checks.planner_mechanical_schema_missing_fields_block = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.planner_mechanical_schema_missing_fields_block = String(error.message).includes("stop before task material write") && String(error.message).includes("interface_contract_kind_values");
  }
  const unknownPlanningPassSeed = exampleSeed("planner-agent__plan-authoring");
  unknownPlanningPassSeed.contract.planning_pass = "revision";
  checks.planner_planning_pass_passes_through = JSON.stringify(expandSeed(unknownPlanningPassSeed)).includes('"planning_pass":"revision"');
  const minimal = {
    route_id: "explorer-agent__codebase-scan",
    goal: "self-test: \u6478\u6E05 ops/tools \u7684\u811A\u672C\u7ED3\u6784\u548C\u5165\u53E3",
    scope: { read: ["ops/tools/"] },
    contract: { scan_mode: "terrain_map", focus: "structure", question: "\u5DE5\u5177\u76EE\u5F55\u6709\u54EA\u4E9B\u5165\u53E3\u811A\u672C\u548C\u804C\u8D23" },
    slug: "dispatch-prepare-self-test"
  };
  const expanded = expandSeed({ ...minimal });
  const contract = expanded.extensions.capability_contract.explorer || {};
  const minimalDirect = prepareDirectPreview(expanded);
  if (minimalDirect.task_package_path) tempPaths.push(path15.join(ROOT2, String(minimalDirect.task_package_path)));
  const minimalAsync = prepareDispatch(expanded, "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter
  });
  if (minimalAsync.task_package_path) tempPaths.push(path15.join(ROOT2, String(minimalAsync.task_package_path)));
  const modelSelection = minimalAsync.async_model_selection || {};
  const explorerDefault = resolveFor("explorer-agent", "codebase-scan");
  const expectedModel = explorerDefault.resolved_model;
  const expectedEffort = explorerDefault.resolved_effort;
  Object.assign(checks, {
    minimal_expanded_full: Object.hasOwn(expanded, "handoff_contract"),
    minimal_slot_explorer: contract.scan_mode === "terrain_map",
    minimal_scope_paths_mirrored: deepEqual(contract.scope_paths, ["ops/tools/"]),
    minimal_report_in_write: expanded.scope.write.includes("notes/explorer/dispatch-prepare-self-test.md"),
    minimal_dispatch_ok: minimalDirect.status === "ok",
    minimal_async_primary_model_from_agent_config: Boolean(expectedModel) && modelSelection.primary_model === expectedModel,
    minimal_async_primary_effort_from_agent_config: Boolean(expectedEffort) && modelSelection.primary_effort === expectedEffort,
    minimal_template_renders: renderTemplate("explorer-agent__codebase-scan").includes("scan_mode"),
    minimal_list_has_card: listCards().some((row) => row.minimal_seed)
  });
  const piEnvelopes = [];
  const piCapturingSubmitter = (operation, args) => {
    const receipt = isolatedSubmitter(operation, args);
    piEnvelopes.push(pyJsonLoads(readText(String(args.dispatch_file))));
    return receipt;
  };
  const piMinimal = { ...minimal, slug: "dispatch-prepare-pi-self-test", budget: { max_elapsed_minutes: 45 } };
  const piAsync = prepareDispatch(expandSeed(piMinimal), "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: piCapturingSubmitter
  });
  if (piAsync.task_package_path) tempPaths.push(path15.join(ROOT2, String(piAsync.task_package_path)));
  const piSelection = piAsync.async_model_selection || {};
  const piDescriptorSelection = (piAsync.descriptor || {}).model_selection || {};
  const piEnvelope = piEnvelopes.length ? piEnvelopes[piEnvelopes.length - 1] : {};
  const expectedPiModel = explorerDefault.resolved_model;
  const expectedPiEffort = explorerDefault.resolved_effort;
  Object.assign(checks, {
    pi_async_ok: piAsync.status === "ok" && piAsync.executor === "pi",
    pi_async_runner_basename: path15.basename(String(piEnvelope.runner_path || "")) === "run-pi-task.mjs",
    pi_async_envelope_carries_seed_budget: piEnvelope.budget?.max_elapsed_minutes === 45,
    pi_async_primary_model_from_pi_config: Boolean(expectedPiModel) && piSelection.primary_model === expectedPiModel,
    pi_async_primary_effort_from_pi_config: Boolean(expectedPiEffort) && piSelection.primary_effort === expectedPiEffort,
    pi_envelope_model_matches_selection: piEnvelope.model === piSelection.primary_model,
    pi_envelope_effort_matches_selection: piEnvelope.effort === piSelection.primary_effort,
    pi_envelope_has_no_model_fallback: !Object.hasOwn(piEnvelope, "model_fallback"),
    pi_envelope_freezes_pick_efforts_and_range: piEnvelope.selection?.pick === explorerDefault.pick && deepEqual(piEnvelope.selection?.efforts, explorerDefault.efforts) && deepEqual(piEnvelope.selection?.effort_range, explorerDefault.effort_range),
    pi_descriptor_freezes_selection_sources: piDescriptorSelection.model === piEnvelope.model && piDescriptorSelection.effort === piEnvelope.effort && piDescriptorSelection.model_source === piSelection.model_source && piDescriptorSelection.effort_source === piSelection.effort_source && deepEqual(piDescriptorSelection.child_model, piSelection.child_model),
    pi_envelope_has_no_executor_field: !Object.hasOwn(piEnvelope, "executor"),
    pi_envelope_contract_unchanged: piEnvelope.contract_version === ASYNC_DISPATCH_CONTRACT_VERSION
  });
  const batchFile = path15.join(ROOT2, "tmp", "dispatch_prepare", `self-test-batch-${timeNs()}.json`);
  mkdirSync7(path15.dirname(batchFile), { recursive: true });
  writeFileSync5(batchFile, JSON.stringify([
    exampleSeed("explorer-agent__codebase-scan"),
    exampleSeed("explorer-agent__runtime-env-scan")
  ]), "utf8");
  try {
    const batchSeeds = loadSeeds({ seed: batchFile, seed_stdin: false, sample_route: null });
    const batchOut = batchSeeds.map((item) => prepareDirectPreview(item));
    for (const item of batchOut) {
      if (item.task_package_path) tempPaths.push(path15.join(ROOT2, String(item.task_package_path)));
    }
    checks.batch_seeds_two = batchOut.length === 2 && batchOut.every((item) => item.delivery_mode === "direct_message");
    checks.batch_policy_parallel = batchSeeds.every(
      (item) => item.concurrency_contract.parallel_policy === "allowed_if_no_conflict"
    );
    const metadataSeeds = [
      {
        route_id: "explorer-agent__codebase-scan",
        goal: "scan the first batch scope",
        scope: { read: ["PROJECT.md"] },
        contract: { scan_mode: "slice_scan", focus: "structure", question: "what is the first batch scope", depth_limit: 1e3 },
        slug: "self-test-batch-a"
      },
      {
        route_id: "explorer-agent__codebase-scan",
        goal: "scan the second batch scope",
        scope: { read: ["AGENTS.md"] },
        contract: { scan_mode: "slice_scan", focus: "structure", question: "what is the second batch scope", depth_limit: 1e3 },
        slug: "self-test-batch-b"
      }
    ];
    const metadataBatch = prepareBatchDispatch(
      metadataSeeds.map((item) => expandDispatchSeed(item)),
      "async-subagent",
      { batchId: "batch-self-test", action: "preview", asyncRunnerPath: fakeRunner, asyncTaskRoot: asyncRoot }
    );
    checks.batch_metadata_is_stable = metadataBatch.status === "ok" && metadataBatch.batch_id === "batch-self-test" && deepEqual((metadataBatch.dispatches || []).map((item) => item.slice_id), ["self-test-batch-a", "self-test-batch-b"]) && (metadataBatch.dispatches || []).every((item) => item.batch_id === "batch-self-test");
  } finally {
    rmSync4(batchFile, { force: true });
  }
  const bomSeedFile = path15.join(ROOT2, "tmp", "dispatch_prepare", `self-test-bom-seed-${timeNs()}.json`);
  mkdirSync7(path15.dirname(bomSeedFile), { recursive: true });
  writeFileSync5(bomSeedFile, Buffer.concat([
    Buffer.from([239, 187, 191]),
    Buffer.from(JSON.stringify(exampleSeed("explorer-agent__codebase-scan")), "utf8")
  ]));
  try {
    const bomSeeds = loadSeeds({ seed: bomSeedFile, seed_stdin: false, sample_route: null });
    checks.seed_file_tolerates_bom = bomSeeds.length === 1 && bomSeeds[0].route_id === "explorer-agent__codebase-scan";
  } finally {
    rmSync4(bomSeedFile, { force: true });
  }
  const nameRoot = mkdtempSync(path15.join(os2.tmpdir(), "dispatch-prepare-server-name-self-test-"));
  try {
    const newConfig = path15.join(nameRoot, "new.toml");
    writeFileSync5(newConfig, `[mcp_servers.${ASYNC_MCP_SERVER_NAME}]
command = "new"
`, "utf8");
    const resolved = _serverFromConfig(newConfig);
    checks.server_name_resolves_new_registration = resolved !== null && resolved.server_name === ASYNC_MCP_SERVER_NAME && resolved.command === "new";
  } finally {
    rmSync4(nameRoot, { recursive: true, force: true });
  }
  const sampleGlobalServer = { source: "global", config_path: "global-config" };
  checks.project_async_mcp_registration_ignored = selectAsyncSubagentServer({ source: "project", config_path: "project-config" }, sampleGlobalServer) === sampleGlobalServer;
  checks.global_async_mcp_registration_selected = selectAsyncSubagentServer(null, sampleGlobalServer) === sampleGlobalServer;
  const resolvedServer = asyncSubagentServer();
  const resolvedScript = resolvedServer ? asyncServerScriptPath(resolvedServer) : null;
  checks.async_server_script_resolves = resolvedServer === null || resolvedScript !== null && isFile4(resolvedScript);
  try {
    expandSeed({ ...minimal, goal: "<\u672C\u6B21\u626B\u63CF\u8981\u56DE\u7B54\u7684\u4E00\u53E5\u8BDD\u95EE\u9898>" });
    checks.minimal_placeholder_rejected = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.minimal_placeholder_rejected = true;
  }
  const documentScanSeed = expandSeed(exampleSeed("research-agent__document-scan"));
  const documentScanOk = prepareDirectPreview(documentScanSeed);
  if (documentScanOk.task_package_path) tempPaths.push(path15.join(ROOT2, String(documentScanOk.task_package_path)));
  checks.vision_requirement_passes_with_configured_model = documentScanOk.status === "ok";
  const documentScanOverride = prepareDirectPreview(documentScanSeed, { asyncModel: "no-vision-fixture-model" });
  checks.vision_requirement_is_task_guidance = documentScanOverride.status === "ok";
  const readOnlyPackage = {
    agent: { role: "general-agent", runtime_role: "general-agent", capability: { name: "general-default" } },
    scope: { read: ["a/"], write: [], delete: [] },
    runtime_context: { network_needed: "no" },
    tool_contract: { allowed: ["read", "grep", "find", "ls"], network_allowed: false, install_allowed: false },
    extensions: {}
  };
  const crossRepoTarget = path15.join(asyncRoot, "target-repo");
  mkdirSync7(crossRepoTarget, { recursive: true });
  writeFileSync5(path15.join(crossRepoTarget, "marker.txt"), "cross-repo self-test\n", "utf8");
  const crossRepoSeed = structuredClone(expanded);
  crossRepoSeed.scope.read = ["marker.txt"];
  if (crossRepoSeed.inputs && typeof crossRepoSeed.inputs === "object" && !Array.isArray(crossRepoSeed.inputs)) {
    crossRepoSeed.inputs.files = ["marker.txt"];
  }
  if (!crossRepoSeed.extensions) crossRepoSeed.extensions = {};
  crossRepoSeed.extensions.cross_repo_acceptance = { result_mode: "read_only_audit" };
  const crossRepoPrepared = prepareDispatch(crossRepoSeed, "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncTargetCwd: crossRepoTarget,
    asyncSubmitter: isolatedSubmitter
  });
  const crossRepoPackagePath = path15.join(ROOT2, String(crossRepoPrepared.task_package_path));
  const crossRepoPackage = pyJsonLoads(readText(crossRepoPackagePath)).task_package;
  checks.cross_repo_target_repo_bound_into_task_package = path15.resolve(crossRepoPackage.runtime_context.target_repo) === path15.resolve(crossRepoTarget);
  tempPaths.push(
    crossRepoPackagePath,
    withSuffix(crossRepoPackagePath, ".task.md"),
    withSuffix(crossRepoPackagePath, ".dispatch.json")
  );
  readOnlyPackage.extensions = { cross_repo_acceptance: { result_mode: "read_only_audit" } };
  const crossRepoOptions = resolveAsyncRuntimeOptions(readOnlyPackage, {
    runnerPath: fakeRunner,
    targetCwd: crossRepoTarget
  });
  checks.cross_repo_task_root_stays_in_controller_runtime = pyIsRelativeTo(
    String(crossRepoOptions.task_root),
    path15.resolve(path15.join(ROOT2, ".runtime"))
  ) && !pyIsRelativeTo(String(crossRepoOptions.task_root), path15.resolve(path15.join(crossRepoTarget, ".runtime")));
  const simulationPackage = structuredClone(readOnlyPackage);
  simulationPackage.extensions.cross_repo_acceptance = {
    result_mode: "simulated_planning",
    simulation: { role: "target-reviewer", persona: { instructions: "\u53EA\u8BFB\u68C0\u67E5\u76EE\u6807\u4ED3\u5165\u53E3", boundaries: ["\u4E0D\u5199\u76EE\u6807\u4ED3"] } }
  };
  const simulationOptions = resolveAsyncRuntimeOptions(simulationPackage, {
    runnerPath: fakeRunner,
    targetCwd: crossRepoTarget
  });
  checks.cross_repo_simulation_profile_comes_from_seed = simulationOptions.result_mode === "simulated_planning" && simulationOptions.simulation_profile.role === "target-reviewer" && simulationOptions.simulation_profile.persona.instructions === "\u53EA\u8BFB\u68C0\u67E5\u76EE\u6807\u4ED3\u5165\u53E3";
  const missingModePackage = structuredClone(readOnlyPackage);
  missingModePackage.extensions = {};
  const defaultAudit = resolveAsyncRuntimeOptions(missingModePackage, {
    runnerPath: fakeRunner,
    targetCwd: crossRepoTarget
  });
  checks.cross_repo_result_mode_defaults_read_only = defaultAudit.result_mode === "read_only_audit" && defaultAudit.warnings.length > 0;
  const evidencePackage = structuredClone(readOnlyPackage);
  evidencePackage.scope.write = ["notes/x.md"];
  evidencePackage.extensions = { review_execution: { profile: PROFILE } };
  const evidenceOptions = resolveAsyncRuntimeOptions(evidencePackage, {
    runnerPath: fakeRunner,
    taskRoot: asyncRoot,
    targetCwd: ROOT2
  });
  checks.evidence_only_resolves_isolated_execution_profile = evidenceOptions.execution_profile === PROFILE && evidenceOptions.context_mode === "isolated";
  const semanticPackage = structuredClone(readOnlyPackage);
  semanticPackage.scope.write = ["notes/verify/semantic-self-test.md"];
  semanticPackage.extensions = { review_execution: { profile: SEMANTIC_PROFILE } };
  const semanticOptions = resolveAsyncRuntimeOptions(semanticPackage, {
    runnerPath: fakeRunner,
    taskRoot: asyncRoot,
    targetCwd: ROOT2
  });
  checks.semantic_review_keeps_standard_project_aware = semanticOptions.execution_profile === "standard" && semanticOptions.context_mode === "project-aware";
  const semanticNetworkLocalTools = structuredClone(semanticPackage);
  semanticNetworkLocalTools.runtime_context = { network_needed: "yes" };
  semanticNetworkLocalTools.tool_contract = { allowed: ["read", "grep", "write"] };
  const semanticLocalOptions = resolveAsyncRuntimeOptions(semanticNetworkLocalTools, {
    runnerPath: fakeRunner,
    taskRoot: asyncRoot,
    targetCwd: ROOT2
  });
  checks.semantic_review_network_needed_preserves_explicit_tools = deepEqual(semanticLocalOptions.tool_allowlist, ["read", "grep", "write"]);
  const semanticNetworkNoTool = structuredClone(semanticPackage);
  semanticNetworkNoTool.runtime_context = { network_needed: "yes" };
  semanticNetworkNoTool.tool_contract = { network_allowed: true, allowed: null };
  const inheritedNetworkOptions = resolveAsyncRuntimeOptions(semanticNetworkNoTool, {
    runnerPath: fakeRunner,
    taskRoot: asyncRoot,
    targetCwd: ROOT2
  });
  checks.semantic_review_network_needed_accepts_inherited_tools = inheritedNetworkOptions.tool_allowlist === null && inheritedNetworkOptions.tool_allowlist_source === "pi_configured_tools";
  const evidenceNetworkPackage = structuredClone(evidencePackage);
  evidenceNetworkPackage.runtime_context = { network_needed: "yes" };
  const assistedOptions = resolveAsyncRuntimeOptions(evidenceNetworkPackage, {
    runnerPath: fakeRunner,
    taskRoot: asyncRoot,
    targetCwd: ROOT2
  });
  checks.evidence_network_uses_assisted_profile = assistedOptions.execution_profile === "standard" && assistedOptions.warnings.length > 0;
  const semanticPreview = prepareDispatch(
    expandDispatchSeed({
      route_id: "semantic-review-agent__rule-quality-inspection",
      goal: "semantic review material self-test",
      scope: { read: ["AGENTS.md", "ops/skills/rule-authoring/SKILL.md"] },
      contract: { target_files: ["AGENTS.md"], inspection_focus: ["single_direction"] }
    }),
    "async-subagent",
    { action: "preview", asyncRunnerPath: fakeRunner, asyncTaskRoot: asyncRoot }
  );
  checks.semantic_preview_uses_full_review_material = (semanticPreview.review_evidence || {}).profile === SEMANTIC_PROFILE && (semanticPreview.review_evidence || {}).material_mode === "full";
  const brokenRouteSeed = exampleSeed("explorer-agent__codebase-scan");
  brokenRouteSeed.route_id = "nonexistent-agent__no-such-capability";
  const batchPartial = prepareBatchDispatch([seed, brokenRouteSeed], "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter
  });
  for (const item of batchPartial.dispatches) {
    if (item.task_package_path) tempPaths.push(path15.join(ROOT2, String(item.task_package_path)));
  }
  checks.batch_partial_status_on_mixed_seeds = batchPartial.status === "partial";
  checks.batch_partial_keeps_first_task_id = Boolean(batchPartial.committed_task_ids.length);
  checks.batch_partial_lists_failed_index = deepEqual(batchPartial.failed_seed_indexes, [2]);
  const batchPartialFailure = batchPartial.dispatches[1];
  checks.batch_partial_failure_carries_phase = batchPartialFailure.phase === "seed" && String(batchPartialFailure.error || "").startsWith("[seed] ");
  checks.batch_partial_dispatches_len_matches_seeds = batchPartial.dispatches.length === 2;
  const conflictSeedA = exampleSeed("explorer-agent__codebase-scan");
  pushWriteExtra(conflictSeedA, "notes/conflict/self-test.md");
  const conflictSeedB = exampleSeed("explorer-agent__runtime-env-scan");
  pushWriteExtra(conflictSeedB, "notes/conflict/self-test.md");
  const conflictSeedC = exampleSeed("explorer-agent__codebase-scan");
  conflictSeedC.slug = "independent-conflict-self-test";
  pushWriteExtra(conflictSeedC, "notes/conflict/independent-self-test.md");
  const batchConflict = prepareBatchDispatch([conflictSeedA, conflictSeedB, conflictSeedC].map((seed2) => expandDispatchSeed(seed2)), "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter
  });
  checks.batch_write_conflict_isolates_participants = batchConflict.status === "partial" && batchConflict.committed_task_ids.length === 1 && deepEqual(batchConflict.dispatches.map((item) => item.status), ["failed", "failed", "ok"]) && deepEqual(batchConflict.failed_seed_indexes, [1, 2]) && deepEqual(batchConflict.not_submitted_seed_indexes, []) && Boolean((batchConflict.batch_write_conflicts || []).length);
  const resolvedConflictSeedA = exampleSeed("explorer-agent__codebase-scan");
  resolvedConflictSeedA.expected_output = {
    mode: "file",
    resolved_file_path: path15.join(ROOT2, "notes/conflict/resolved-self-test.md")
  };
  const resolvedConflictSeedB = exampleSeed("explorer-agent__runtime-env-scan");
  resolvedConflictSeedB.handoff_contract = {
    resolved_handoff_file: path15.join(ROOT2, "notes/conflict/resolved-self-test.md")
  };
  const resolvedBatchConflict = prepareBatchDispatch([resolvedConflictSeedA, resolvedConflictSeedB], "async-subagent", {
    asyncRunnerPath: fakeRunner,
    asyncTaskRoot: asyncRoot,
    asyncSubmitter: isolatedSubmitter
  });
  checks.batch_resolved_write_conflict_blocks_all = resolvedBatchConflict.status === "failed" && deepEqual(resolvedBatchConflict.committed_task_ids, []) && deepEqual(resolvedBatchConflict.failed_seed_indexes, [1, 2]) && deepEqual(resolvedBatchConflict.not_submitted_seed_indexes, []) && Boolean((resolvedBatchConflict.batch_write_conflicts || []).length);
  checks.scope_preflight_small_scope_no_warning = (dryDirect.scope_preflight || {}).scope_preflight_warning === null && (dryDirect.scope_preflight || {}).scope_file_count === 1;
  const heavyDir = mkdtempSync(path15.join(os2.tmpdir(), "dispatch-prepare-preflight-self-test-"));
  try {
    const initialized = spawnSync5("git", ["init", "-q", heavyDir], { encoding: "utf8", windowsHide: true });
    if (initialized.status !== 0) throw new Error(`preflight fixture git init failed: ${initialized.stderr}`);
    for (let index = 0; index < PREFLIGHT_FILE_THRESHOLD + 100; index += 1) {
      writeFileSync5(path15.join(heavyDir, `f${index}.txt`), "x", "utf8");
    }
    const heavyPreflight = computeScopePreflight([heavyDir], { baseRoot: heavyDir });
    checks.scope_preflight_over_threshold_warns = Boolean(heavyPreflight.scope_preflight_warning);
    checks.scope_preflight_over_threshold_file_count = heavyPreflight.scope_file_count === PREFLIGHT_FILE_THRESHOLD + 100;
  } finally {
    rmSync4(heavyDir, { recursive: true, force: true });
  }
  const gitRoot = mkdtempSync(path15.join(os2.tmpdir(), "dispatch-prepare-git-ignore-self-test-"));
  try {
    const initialized = spawnSync5("git", ["init", "-q", gitRoot], { encoding: "utf8", windowsHide: true });
    writeFileSync5(path15.join(gitRoot, ".gitignore"), ".runtime/\nnode_modules/\ntmp/\nops/dist/\n", "utf8");
    writeFileSync5(path15.join(gitRoot, "kept.txt"), "kept\n", "utf8");
    for (const relative of [".runtime/tasks", "node_modules/pkg", "tmp/cache", "ops/dist/assets"]) {
      const ignoredDir = path15.join(gitRoot, relative);
      mkdirSync7(ignoredDir, { recursive: true });
      writeFileSync5(path15.join(ignoredDir, "ignored.txt"), "ignored\n", "utf8");
    }
    const originalWalk = deps.walk;
    deps.walk = function* poisonWalk() {
      throw new Error("ignored tree walk");
    };
    let ignoredPreflight = null;
    try {
      ignoredPreflight = computeScopePreflight(["."], { baseRoot: gitRoot });
    } catch {
      ignoredPreflight = null;
    } finally {
      deps.walk = originalWalk;
    }
    checks.scope_preflight_respects_git_ignore = ignoredPreflight !== null && initialized.status === 0 && ignoredPreflight.scope_file_count === 2;
  } finally {
    rmSync4(gitRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  const missingPreflight = computeScopePreflight(["notes/does-not-exist-preflight-self-test/"]);
  checks.scope_preflight_missing_path_is_reported = missingPreflight.scope_file_count === 0 && deepEqual(missingPreflight.scope_missing_paths, ["notes/does-not-exist-preflight-self-test/"]) && deepEqual(missingPreflight.scope_unreadable_paths, []);
  const urlPreflight = computeScopePreflight(["https://example.com/docs", "ops/tools/dispatch_prepare.mjs"]);
  checks.scope_preflight_url_entries_skip_stat = urlPreflight.scope_url_count === 1 && deepEqual(urlPreflight.scope_missing_paths, []) && urlPreflight.scope_file_count === 1;
  try {
    enforceScopePreflight(urlPreflight);
    checks.scope_preflight_url_entries_pass_enforcement = true;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    checks.scope_preflight_url_entries_pass_enforcement = false;
  }
  checks.scope_preflight_missing_path_is_diagnostic = enforceScopePreflight(missingPreflight).length > 0;
  const layeredSeed = {
    route_id: "explorer-agent__codebase-scan",
    goal: "self-test layered read scope",
    scope: { read: ["ops/tools/", "runs/"] },
    contract: { scan_mode: "terrain_map", focus: "structure", question: "\u5206\u5C42\u8BFB\u53D6\u81EA\u6D4B" },
    slug: "dispatch-prepare-layers-self-test",
    read_scope_layers: {
      entry: ["ops/tools/seed_minimal.mjs"],
      index: ["ops/tools/"],
      deep: [{ path: "notes/", when: "\u547D\u4E2D\u626B\u63CF\u63A5\u7F1D\u65F6" }],
      deferred: ["runs/"]
    },
    budget: { max_tool_calls: 40, max_elapsed_minutes: 10 }
  };
  const extractedLayers = readScopeLayersFromSeed(layeredSeed);
  const layeredPreflightPaths = preflightReadPaths(extractedLayers, layeredSeed.scope.read);
  const layeredDirective = renderReadScopeLayers(extractedLayers);
  const extractedBudget = seedBudget(layeredSeed);
  let nonpositiveBudgetRejected = false;
  try {
    seedBudget({ budget: { max_elapsed_minutes: -1 } });
    nonpositiveBudgetRejected = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    nonpositiveBudgetRejected = true;
  }
  const layeredDry = prepareDispatch(expandSeed({ ...layeredSeed }), "direct", { action: "preview" });
  checks.read_scope_layers_extracted = extractedLayers !== null && deepEqual(extractedLayers.deferred, ["runs/"]) && deepEqual(extractedLayers.deep, [{ path: "notes/", when: "\u547D\u4E2D\u626B\u63CF\u63A5\u7F1D\u65F6" }]);
  checks.read_scope_layers_preflight_entry_index_only = deepEqual(layeredPreflightPaths, ["ops/tools/seed_minimal.mjs", "ops/tools/"]) && !layeredPreflightPaths.includes("runs/");
  checks.read_scope_layers_dry_run_carries_directive = Object.hasOwn(layeredDry, "read_scope_layers_directive") && layeredDry.budget_enforcement?.max_elapsed_minutes === "enforced_per_attempt";
  checks.seed_budget_rejects_nonpositive = nonpositiveBudgetRejected;
  checks.seed_budget_ignores_legacy_tool_calls = deepEqual(extractedBudget, { max_elapsed_minutes: 10 }) && deepEqual(layeredDry.budget_enforcement, { max_elapsed_minutes: "enforced_per_attempt" });
  const ownedPreparationRoots = /* @__PURE__ */ new Set();
  for (const item of isolatedSubmissions) {
    if (path15.basename(path15.dirname(item)).startsWith("prep-")) ownedPreparationRoots.add(path15.resolve(path15.dirname(item)));
  }
  for (const item of tempPaths) {
    if (path15.basename(path15.dirname(item)).startsWith("prep-")) ownedPreparationRoots.add(path15.resolve(path15.dirname(item)));
  }
  for (const preparation of ownedPreparationRoots) {
    try {
      rmSync4(preparation, { recursive: true, force: false, maxRetries: 10, retryDelay: 50 });
    } catch {
      checks[`cleanup::${rel(preparation)}`] = false;
    }
  }
  for (const item of tempPaths) {
    if (path15.basename(path15.dirname(item)).startsWith("prep-")) continue;
    try {
      rmSync4(item, { force: true });
    } catch {
      checks[`cleanup::${rel(item)}`] = false;
    }
  }
  const registryRoot = process7.env.SUBAGENT_REGISTRY_ROOT || defaultRegistryRoot();
  if (isDir(registryRoot)) {
    for (const name of readdirSync6(registryRoot)) {
      if (!name.endsWith(".json")) continue;
      const registryFile = path15.join(registryRoot, name);
      try {
        const record2 = pyJsonLoads(readText(registryFile));
        if (path15.resolve(String(record2.task_root || "")) === path15.resolve(asyncRoot)) rmSync4(registryFile, { force: true });
      } catch {
        continue;
      }
    }
  }
  const selfTestRoot = path15.join(ROOT2, ".runtime", "self-tests");
  if (pyIsRelativeTo(path15.resolve(asyncRoot), path15.resolve(selfTestRoot))) {
    rmSync4(asyncRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } else {
    checks["cleanup::async_root_boundary"] = false;
  }
  return {
    status: Object.values(checks).every(Boolean) ? "ok" : "failed",
    checks,
    verification: {
      readiness_and_submit_share_configured_endpoint: checks.readiness_and_submit_share_configured_endpoint,
      invalid_input_has_no_evidence_or_material_writes: checks.invalid_task_root_rejected_before_write,
      auto_submit_returns_task_id: checks.auto_has_task_id,
      prepared_submit_returns_task_id: checks.async_has_task_id,
      direct_runtime_is_blocked: checks.direct_runtime_blocked,
      async_failure_has_no_sync_fallback: checks.direct_runtime_blocked
    }
  };
}
function withSuffix(target, suffix) {
  const dir = path15.dirname(target);
  const base = path15.basename(target);
  const dot = base.lastIndexOf(".");
  return path15.join(dir, (dot > 0 ? base.slice(0, dot) : base) + suffix);
}
function pushWriteExtra(seed, value) {
  if (!seed.scope) seed.scope = {};
  if (!seed.scope.write_extra) seed.scope.write_extra = [];
  seed.scope.write_extra.push(value);
}
var ROOT2, ToolError2, deps, selectionConfig, configuredModels, SELF_TEST_CHILD_CATALOG;
var init_dispatch_prepare_selftest = __esm({
  async "ops/tools/dispatch_prepare.selftest.mjs"() {
    await init_dispatch_prepare();
    init_seed_minimal();
    init_py();
    init_tool_common();
    init_model_selection();
    ({ ROOT: ROOT2, ToolError: ToolError2, deps } = dispatch_prepare_exports);
    selectionConfig = loadSelectionConfig(modelConfigSources());
    configuredModels = [...new Set([...selectionConfig.roles.values()].flatMap((role) => role.picks.map((pick) => pick.model)))].sort();
    SELF_TEST_CHILD_CATALOG = {
      status: "ok",
      models: configuredModels,
      model_count: configuredModels.length,
      source: "dispatch_prepare self-test child catalog",
      error: null
    };
  }
});

// ops/tools/dispatch-core/dispatch_prepare.mjs
var dispatch_prepare_exports = {};
__export(dispatch_prepare_exports, {
  ACCEPTANCE_SYNTHESIS_PROFILE: () => ACCEPTANCE_SYNTHESIS_PROFILE,
  ASYNC_DISPATCH_CONTRACT_VERSION: () => ASYNC_DISPATCH_CONTRACT_VERSION,
  ASYNC_MCP_SERVER_NAME: () => ASYNC_MCP_SERVER_NAME,
  CROSS_REPO_RESULT_MODES: () => CROSS_REPO_RESULT_MODES,
  EVIDENCE_ONLY_PROFILE: () => PROFILE,
  GLOBAL_CONFIG_PATH: () => GLOBAL_CONFIG_PATH,
  PI_ASYNC_RUNNER_SENTINEL: () => PI_ASYNC_RUNNER_SENTINEL,
  PREFLIGHT_BINARY_LIKE_EXTENSIONS: () => PREFLIGHT_BINARY_LIKE_EXTENSIONS,
  PREFLIGHT_BYTES_THRESHOLD: () => PREFLIGHT_BYTES_THRESHOLD,
  PREFLIGHT_FILE_THRESHOLD: () => PREFLIGHT_FILE_THRESHOLD,
  PREFLIGHT_GIT_TIMEOUT_SECONDS: () => PREFLIGHT_GIT_TIMEOUT_SECONDS,
  PREFLIGHT_LARGE_FILE_BYTES: () => PREFLIGHT_LARGE_FILE_BYTES,
  PREFLIGHT_STAT_FILE_CAP: () => PREFLIGHT_STAT_FILE_CAP,
  PREFLIGHT_WALK_SKIP_DIRS: () => PREFLIGHT_WALK_SKIP_DIRS,
  PREFLIGHT_WALK_SKIP_PATHS: () => PREFLIGHT_WALK_SKIP_PATHS,
  PREPARED_DISPATCH_CONTRACT_VERSION: () => DISPATCH_CONTRACT_VERSION,
  PROJECT_ASYNC_TASK_ROOT: () => PROJECT_ASYNC_TASK_ROOT,
  PreparedDispatchError: () => PreparedDispatchError,
  ROOT: () => ROOT,
  RUNTIME_ROOT: () => RUNTIME_ROOT,
  SEMANTIC_REVIEW_PROFILE: () => SEMANTIC_PROFILE,
  ToolError: () => ToolError,
  ValidTaskId: () => _validTaskId,
  _probePiChildModelCatalogUncached: () => _probePiChildModelCatalogUncached,
  _serverFromConfig: () => _serverFromConfig,
  _validTaskId: () => _validTaskId,
  agentConfigEntry: () => agentConfigEntry,
  agentPanelLaunchText: () => agentPanelLaunchText,
  applyRoleWorkerResources: () => applyRoleWorkerResources,
  asyncDispatchContractStatus: () => asyncDispatchContractStatus,
  asyncServerEnv: () => asyncServerEnv,
  asyncServerScriptPath: () => asyncServerScriptPath,
  asyncSubagentEndpoint: () => asyncSubagentEndpoint,
  asyncSubagentReadiness: () => asyncSubagentReadiness,
  asyncSubagentServer: () => asyncSubagentServer,
  attachAgentPanelLaunch: () => attachAgentPanelLaunch,
  attachReviewEvidence: () => attachReviewEvidence,
  batchWriteConflicts: () => batchWriteConflicts,
  buildPackage: () => buildPackage,
  callAsyncInternalAdapter: () => callAsyncInternalAdapter,
  cardFor: () => cardFor,
  checkRouteCard: () => checkRouteCard,
  clampDisplayTitle: () => clampDisplayTitle,
  clearCaches: () => clearCaches,
  clearModelCatalogCache: () => clearModelCatalogCache,
  compilePreparedDispatch: () => compilePreparedDispatch,
  computeScopePreflight: () => computeScopePreflight,
  conditionalRequiredFiles: () => conditionalRequiredFiles,
  conflictPaths: () => conflictPaths,
  currentDispatchPhase: () => currentDispatchPhase,
  defaultRegistryRoot: () => defaultRegistryRoot,
  deps: () => deps2,
  emit: () => emit,
  enforceScopePreflight: () => enforceScopePreflight,
  exampleSeed: () => exampleSeed,
  expandDispatchSeed: () => expandDispatchSeed,
  expandSeed: () => expandSeed,
  isPyCaughtError: () => isPyCaughtError,
  isStaticReview: () => isStaticReview,
  jsonDumpsIndent2: () => jsonDumpsIndent2,
  legacyOriginId: () => legacyOriginId,
  lintOrFail: () => lintOrFail,
  lintPackage: () => lintPackage,
  listCards: () => listCards,
  loadSeeds: () => loadSeeds,
  loadToml: () => loadToml,
  makeBatchId: () => makeBatchId,
  markDispatchPhase: () => markDispatchPhase,
  normalizeDispatchAction: () => normalizeDispatchAction,
  packagePathForTemp: () => packagePathForTemp,
  parseSeed: () => parseSeed,
  piChildCatalogCommand: () => piChildCatalogCommand,
  piChildModelExtensionProfile: () => piChildModelExtensionProfile,
  preflightReadPaths: () => preflightReadPaths,
  prepareAsyncSubagent: () => prepareAsyncSubagent,
  prepareBatchDispatch: () => prepareBatchDispatch,
  prepareDirect: () => prepareDirect,
  prepareDirectPreview: () => prepareDirectPreview,
  prepareDispatch: () => prepareDispatch,
  prepareDryRun: () => prepareDryRun,
  probePiChildModelCatalog: () => probePiChildModelCatalog,
  profileFor: () => profileFor,
  projectConditionalRequiredFiles: () => projectConditionalRequiredFiles,
  pyList: () => pyList,
  pySlice: () => pySlice,
  readScopeLayersFromSeed: () => readScopeLayersFromSeed,
  readSeedFileText: () => readSeedFileText,
  readStdinText: () => readStdinText,
  rel: () => rel,
  renderAsyncTaskPayload: () => renderAsyncTaskPayload,
  renderDirectFileRefPayload: () => renderDirectFileRefPayload,
  renderReadScopeLayers: () => renderReadScopeLayers,
  renderTaskMaterialFile: () => renderTaskMaterialFile,
  renderTemplate: () => renderTemplate,
  requirePiChildModel: () => requirePiChildModel,
  resolveAsyncModelSelection: () => resolveAsyncModelSelection,
  resolveAsyncRuntimeOptions: () => resolveAsyncRuntimeOptions,
  resolveDelivery: () => resolveDelivery,
  resolveDeliveryWithReadiness: () => resolveDeliveryWithReadiness,
  resolveRoleModelSelection: () => resolveRoleModelSelection,
  reviewExecutionProfile: () => reviewExecutionProfile,
  routeIdFromAgent: () => routeIdFromAgent,
  routesWithCards: () => routesWithCards,
  sampleSeed: () => sampleSeed,
  seedBudget: () => seedBudget,
  seedWriteConflictPaths: () => seedWriteConflictPaths,
  selectAsyncSubagentServer: () => selectAsyncSubagentServer,
  selfTest: () => selfTest2,
  shutilWhich: () => shutilWhich,
  sliceMetadata: () => sliceMetadata,
  taskPackageOutputSummary: () => taskPackageOutputSummary,
  taskToolAllowlist: () => taskToolAllowlist,
  truthyText: () => truthyText,
  verifyPreparedDispatch: () => verifyPreparedDispatch,
  walkDir: () => walkDir
});
import { spawnSync as spawnSync6 } from "node:child_process";
import { createHash as createHash5 } from "node:crypto";
import { existsSync as existsSync10, mkdirSync as mkdirSync8, readdirSync as readdirSync7, readFileSync as readFileSync10, statSync as statSync12, writeFileSync as writeFileSync6 } from "node:fs";
import path16 from "node:path";
import process8 from "node:process";
function clearCaches() {
  for (const cache of Object.values(caches)) cache.clear();
}
function clearModelCatalogCache() {
  caches.childModelCatalog.clear();
}
function compareCodePoints2(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sortedStrings(values) {
  return [...values].sort(compareCodePoints2);
}
function pySlice(value, limit) {
  return Array.from(String(value)).slice(0, limit).join("");
}
function pyList(value) {
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string") return Array.from(value);
  if (isRecord(value)) return Object.keys(value);
  return [];
}
function isSystemError(error) {
  return Boolean(error) && typeof error.code === "string" && (error.errno !== void 0 || error.syscall !== void 0);
}
function isPyCaughtError(error, names) {
  if (!error) return false;
  if (names.has(String(error.name))) return true;
  return names.has("OSError") && isSystemError(error);
}
function statOrNull3(target) {
  try {
    return statSync12(target);
  } catch {
    return null;
  }
}
function isFile5(target) {
  return Boolean(statOrNull3(target)?.isFile());
}
function isDirectory2(target) {
  return Boolean(statOrNull3(target)?.isDirectory());
}
function pathParts2(value) {
  return String(value ?? "").split(/[\\/]+/).filter((part) => part && part !== ".");
}
function jsonDumpsIndent2(value) {
  return JSON.stringify(value, null, 2);
}
function jsonDumpsCompact(value) {
  return JSON.stringify(value);
}
function shutilWhich(name) {
  const candidate = String(name ?? "");
  if (!candidate) return null;
  const isWindows = process8.platform === "win32";
  const exts = isWindows ? String(process8.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const hasExt = isWindows && exts.some((ext) => candidate.toLowerCase().endsWith(ext.toLowerCase()));
  const names = isWindows && !hasExt ? exts.map((ext) => candidate + ext) : [candidate];
  if (candidate.includes("/") || candidate.includes("\\")) {
    for (const item of names) if (isFile5(item)) return item;
    return null;
  }
  const dirs = String(process8.env.PATH || "").split(path16.delimiter).filter(Boolean);
  if (isWindows) dirs.unshift(process8.cwd());
  for (const dir of dirs) {
    for (const item of names) {
      const full = path16.join(dir, item);
      if (isFile5(full)) return full;
    }
  }
  return null;
}
function defaultRegistryRoot() {
  return path16.join(homeDir(), ".subagent-control", "async_task_registry");
}
function configSource(_configPath) {
  return "global";
}
function configBase(configPath) {
  return path16.dirname(String(configPath));
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
  const envConfig = pyStrip(String(process8.env.COCKPIT_GLOBAL_CONFIG || ""));
  const globalConfig = deps2.globalConfigPath || (envConfig || path16.join(homeDir(), ".codex", "config.toml"));
  return _serverFromConfig(globalConfig);
}
function asyncSubagentServer() {
  if (!caches.asyncSubagentServer.has("value")) {
    caches.asyncSubagentServer.set("value", deps2.asyncSubagentServer());
  }
  return caches.asyncSubagentServer.get("value");
}
function selectAsyncSubagentServer(projectServer, globalServer) {
  return globalServer;
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
    caches.asyncSubagentEndpoint.set("value", deps2.asyncSubagentEndpoint());
  }
  return caches.asyncSubagentEndpoint.get("value");
}
function asyncServerEnv(server) {
  return { ...process8.env, ...pyTruthy(server?.env) ? server.env : {} };
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
    completed = spawnSync6("git", ["-C", String(baseRoot), "rev-parse", "--show-toplevel"], {
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
    completed = spawnSync6("git", argv, {
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
    const candidate = path16.join(String(gitRoot), chunk);
    try {
      relativePartsOrThrow(resolveLikePython(candidate), resolveLikePython(directory));
    } catch {
      continue;
    }
    if (isFile5(candidate)) files.push(candidate);
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
      entries = readdirSync7(dirpath, { withFileTypes: true });
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
      stack.push(path16.join(dirpath, frame.dirnames[index]));
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
      size = statSync12(target).size;
    } catch (error) {
      unreadablePaths.push(`${target}: ${error.message}`);
      return true;
    }
    fileCount += 1;
    totalBytes += size;
    if (size > PREFLIGHT_LARGE_FILE_BYTES) largeFileCount += 1;
    if (PREFLIGHT_BINARY_LIKE_EXTENSIONS.has(path16.extname(String(target)).toLowerCase())) binaryLikeCount += 1;
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
      info = existsSync10(resolved) ? statSync12(resolved) : null;
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
    for (const frame of deps2.walk(resolved, recordWalkError)) {
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
        if (!accountFile(path16.join(frame.dirpath, name))) {
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
function enforceScopePreflight(scopePreflight) {
  const missing = pyList(pyTruthy(scopePreflight?.scope_missing_paths) ? scopePreflight.scope_missing_paths : []).map(pyStr);
  const unreadable = pyList(pyTruthy(scopePreflight?.scope_unreadable_paths) ? scopePreflight.scope_unreadable_paths : []).map(pyStr);
  return [
    ...missing.length ? [`scope.read path does not exist: ${missing.join(", ")}`] : [],
    ...unreadable.length ? [`scope.read path is not readable: ${unreadable.join("; ")}`] : []
  ];
}
function readScopeLayersFromSeed(seed) {
  const layers = seed?.read_scope_layers;
  if (!isRecord(layers)) return null;
  const strings = (key) => pyList(pyTruthy(layers[key]) ? layers[key] : []).filter((item) => typeof item === "string" && pyStrip(item));
  const deep = [];
  for (const item of pyList(pyTruthy(layers.deep) ? layers.deep : [])) {
    if (isRecord(item) && typeof item.path === "string" && pyStrip(item.path)) {
      deep.push({ path: item.path, when: pyStr(pyTruthy(item.when) ? item.when : "") });
    } else if (typeof item === "string" && pyStrip(item)) {
      deep.push({ path: item, when: "" });
    }
  }
  return { entry: strings("entry"), index: strings("index"), deep, deferred: strings("deferred") };
}
function preflightReadPaths(layers, fallbackRead) {
  if (layers === null || layers === void 0) return [...pyList(fallbackRead)];
  return [...pyGetItem(layers, "entry"), ...pyGetItem(layers, "index")];
}
function renderReadScopeLayers(layers) {
  const lines = ["\u5206\u5C42\u8BFB\u53D6\u6307\u4EE4\uFF08read_scope_layers\uFF09\uFF1A"];
  lines.push("- entry\uFF1A\u5FC5\u8BFB\u5168\u6587\u3002");
  for (const item of pyGetItem(layers, "entry")) lines.push(`  - ${item}`);
  lines.push("- index\uFF1A\u53EA\u5217\u76EE\u5F55/\u6E05\u5355\uFF0C\u4E0D\u8BFB\u6587\u4EF6\u5185\u5BB9\u3002");
  for (const item of pyGetItem(layers, "index")) lines.push(`  - ${item}`);
  lines.push("- deep\uFF1A\u4EC5\u547D\u4E2D when \u6761\u4EF6\u624D\u6DF1\u5165\u3002");
  for (const item of pyGetItem(layers, "deep")) lines.push(`  - ${item.path}\uFF08when: ${item.when}\uFF09`);
  lines.push("- deferred\uFF1A\u9ED8\u8BA4\u7981\u8BFB\uFF1B\u8BFB\u524D\u5FC5\u987B\u5728\u62A5\u544A\u8BF4\u660E\u7406\u7531\u3002");
  for (const item of pyGetItem(layers, "deferred")) lines.push(`  - ${item}`);
  return lines.join("\n");
}
function seedBudget(seed) {
  const raw = seed?.budget;
  if (raw === null || raw === void 0) return {};
  if (!isRecord(raw)) throw new ToolError("seed.budget must be an object with max_elapsed_minutes");
  const out = {};
  for (const key of ["max_elapsed_minutes"]) {
    if (Object.hasOwn(raw, key) && raw[key] !== null && raw[key] !== void 0) {
      const value = raw[key];
      if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
        throw new ToolError(`seed.budget.${key} must be a positive number`);
      }
      out[key] = value;
    }
  }
  return out;
}
function conflictPaths(value) {
  if (typeof value === "string") return pyStrip(value) ? [value] : [];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && pyStrip(item)).map(String);
  return [];
}
function seedWriteConflictPaths(seed) {
  const scope = isRecord(seed?.scope) ? seed.scope : {};
  const expected = isRecord(seed?.expected_output) ? seed.expected_output : {};
  const handoff = isRecord(seed?.handoff_contract) ? seed.handoff_contract : {};
  const concurrency = isRecord(seed?.concurrency_contract) ? seed.concurrency_contract : {};
  const conflictKeys = isRecord(concurrency.conflict_keys) ? concurrency.conflict_keys : {};
  const rawPaths = [];
  rawPaths.push(...conflictPaths(scope.write));
  rawPaths.push(...conflictPaths(scope.write_extra));
  rawPaths.push(...conflictPaths(scope.delete));
  rawPaths.push(...conflictPaths(conflictKeys.write));
  rawPaths.push(...conflictPaths(conflictKeys.delete));
  rawPaths.push(...conflictPaths(conflictKeys.output));
  for (const key of ["file_path", "path", "resolved_file_path"]) {
    rawPaths.push(...conflictPaths(expected[key]));
  }
  rawPaths.push(...conflictPaths(handoff.handoff_file));
  rawPaths.push(...conflictPaths(handoff.resolved_handoff_file));
  const normalized = /* @__PURE__ */ new Set();
  for (const item of rawPaths) {
    const value = normalizeConflictPath(item);
    if (value) normalized.add(value);
  }
  return sortedStrings(normalized);
}
function batchWriteConflicts(seeds) {
  const rows = seeds.map((seed, idx) => ({
    seed_index: idx + 1,
    route_id: pyStr(pyTruthy(seed?.route_id) ? seed.route_id : ""),
    write_paths: seedWriteConflictPaths(seed)
  }));
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex];
    for (const right of rows.slice(leftIndex + 1)) {
      const hits = [];
      for (const leftPath of left.write_paths) {
        for (const rightPath of right.write_paths) {
          if (pathConflict(leftPath, rightPath)) hits.push({ left: leftPath, right: rightPath });
        }
      }
      if (hits.length) {
        conflicts.push({
          left_seed_index: left.seed_index,
          right_seed_index: right.seed_index,
          left_route_id: left.route_id,
          right_route_id: right.route_id,
          conflicts: hits
        });
      }
    }
  }
  return conflicts;
}
function readSeedFileText(target) {
  let rawBytes;
  try {
    rawBytes = readFileSync10(String(target));
  } catch (error) {
    const detail = systemErrorText(error);
    throw new ToolError(`cannot read --seed file: ${target}: ${detail}`);
  }
  const stripped = rawBytes.length >= 3 && rawBytes[0] === 239 && rawBytes[1] === 187 && rawBytes[2] === 191 ? rawBytes.subarray(3) : rawBytes;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stripped);
  } catch {
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 255 && rawBytes[1] === 254 && rawBytes.length % 2 === 0) {
    return rawBytes.subarray(2).toString("utf16le");
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 254 && rawBytes[1] === 255 && rawBytes.length % 2 === 0) {
    const swapped = Buffer.from(rawBytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  throw new ToolError(`--seed file invalid encoding; expected UTF-8 (with or without BOM) or UTF-16: ${target}`);
}
function systemErrorText(error) {
  const map = {
    ENOENT: "No such file or directory",
    EACCES: "Permission denied",
    EISDIR: "Is a directory",
    ENOTDIR: "Not a directory",
    EPERM: "Operation not permitted",
    EMFILE: "Too many open files"
  };
  return map[error?.code] || String(error?.message ?? error);
}
function expandDispatchSeed(seed) {
  const expanded = expandSeed(parseSeed(JSON.stringify(seed)));
  for (const key of ["slice_id", "slug", "title"]) {
    const value = seed?.[key];
    if (value !== null && value !== void 0 && value !== "") expanded[key] = value;
  }
  return expanded;
}
function loadSeeds(args) {
  const sources = [Boolean(pyTruthy(args?.seed)), Boolean(pyTruthy(args?.seed_stdin)), Boolean(pyTruthy(args?.sample_route))];
  if (sources.filter(Boolean).length !== 1) {
    throw new ToolError("provide exactly one of --seed, --seed-stdin or --sample-route");
  }
  if (pyTruthy(args.sample_route)) return [sampleSeed(args.sample_route)];
  const raw = pyTruthy(args.seed_stdin) ? readStdinText("--seed-stdin") : readSeedFileText(args.seed);
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name === "JSONDecodeError") throw new ToolError(`seed JSON invalid: ${error.message}`);
    throw error;
  }
  if (Array.isArray(data)) {
    if (!data.length) throw new ToolError("seed array is empty");
    return data.map((item) => expandDispatchSeed(item));
  }
  return [expandDispatchSeed(data)];
}
function lintOrFail(pkg) {
  const issues = lintPackage(pkg, { compiled: true });
  if (issues.length) throw new ToolError(`task package lint failed: ${issues.join("; ")}`);
}
function packagePathForTemp(pkg) {
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId2 = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "package");
  const safe = pySlice(
    Array.from(packageId2).map((ch) => /[\p{L}\p{N}]/u.test(ch) || "._-".includes(ch) ? ch : "-").join(""),
    120
  );
  const target = path16.join(ROOT, "tmp", "dispatch_prepare", `${safe}-${ids.uuidHex()}.task-package.json`);
  mkdirSync8(path16.dirname(target), { recursive: true });
  writeFileSync6(target, `${jsonDumpsCompact(pkg)}
`, "utf8");
  return target;
}
function loadToml(target) {
  let text3;
  try {
    text3 = readFileSync10(String(target), "utf8");
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
function resolveDelivery(delivery) {
  return deps2.resolveDelivery(delivery);
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
  if (pyTruthy(toolPath) && !isFile5(toolPath)) {
    issues.push(`missing async tool: ${toolPath}`);
  } else if (!pyTruthy(toolPath)) {
    issues.push("mcp_servers.asyncSubagent args do not include an .mjs server script");
  }
  if (!issues.length) {
    try {
      buildInfo = deps2.callAsyncInternalAdapter("build-info", {});
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
    caches.asyncSubagentReadiness.set("value", deps2.asyncSubagentReadiness());
  }
  return caches.asyncSubagentReadiness.get("value");
}
function renderDirectFileRefPayload(packagePath) {
  const packageRel = rel(packagePath);
  return [
    `DIRECT_TASK_PACKAGE_FILE: ${packageRel}`,
    "",
    "\u8BF7\u5148\u8FD0\u884C\u4EE5\u4E0B\u547D\u4EE4\u8BFB\u53D6\u5B8C\u6574\u4EFB\u52A1\u6750\u6599\uFF0C\u7136\u540E\u53EA\u6309\u4EFB\u52A1\u6750\u6599\u6267\u884C\uFF1A",
    `node ops/tools/subagent_preload.mjs render --package ${packageRel}`,
    "",
    "\u8FD9\u4E00\u6B65\u53EA\u662F\u8BFB\u53D6 direct \u542F\u52A8\u6750\u6599\uFF1B\u4E0D\u8981\u81EA\u884C\u626B\u63CF .runtime\u3001notes \u6216\u4ED3\u5E93\u6839\u76EE\u5F55\u5BFB\u627E\u4EFB\u52A1\u5305\u3002"
  ].join("\n");
}
function _validTaskId(taskId) {
  return typeof taskId === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(taskId);
}
function renderAsyncTaskPayload(packagePath, taskId) {
  const packageRel = rel(packagePath);
  return [
    `SUBAGENT_TASK_ID: ${taskId}`,
    `TASK_PACKAGE_FILE: ${packageRel}`,
    "",
    "\u5F02\u6B65\u5B50\u4EE3\u7406\u4EFB\u52A1\u5DF2\u63D0\u4EA4\uFF1B\u4E0D\u8981\u53E6\u8D70\u540C\u6B65\u6D3E\u53D1\u3002",
    `\u65E0\u5176\u4ED6\u5DE5\u4F5C\u65F6\u7B49\u4E00\u6B21\u7EC8\u6001\uFF1Asubagent_wait({"task_id":"${taskId}","timeout_ms":60000})`,
    `\u7EC8\u6001\u6536\u8F7B\u91CF\u56DE\u6267\uFF1Asubagent_result({"task_id":"${taskId}"})`
  ].join("\n");
}
function callAsyncInternalAdapterImpl(operation, args) {
  const [server, toolPath] = asyncSubagentEndpoint();
  if (!pyTruthy(server)) {
    throw new ToolError(
      "async subagent MCP server is missing from the user-level config (~/.codex/config.toml); register it with python -B ops/tools/deploy_subagent_bundle.py --apply and re-check build-info with --delivery auto, or dispatch through the Pi native dispatch_prepare tool, which uses the session AsyncTaskService instead of this endpoint"
    );
  }
  if (!pyTruthy(toolPath) || !isFile5(toolPath)) {
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
function callAsyncInternalAdapter(operation, args) {
  return deps2.callAsyncInternalAdapter(operation, args);
}
function prepareDirect(pkg) {
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId2 = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const agentType = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : pyTruthy(agent.role) ? agent.role : "");
  const packagePath = packagePathForTemp(pkg);
  return {
    status: "ok",
    delivery_mode: "direct_message",
    direct_payload_mode: "file_ref",
    package_id: packageId2,
    agent_type: agentType,
    task_package_path: rel(packagePath),
    spawn_payload: renderDirectFileRefPayload(packagePath)
  };
}
function taskToolAllowlist(taskPackage) {
  const contract = isRecord(taskPackage?.tool_contract) ? taskPackage.tool_contract : {};
  const allowed = contract.allowed;
  if (allowed === null || allowed === void 0) return null;
  if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !pyStrip(item))) {
    throw new ToolError("task_package.tool_contract.allowed must be null or an array of non-empty Pi tool names");
  }
  return [...new Set(allowed.map((item) => pyStrip(item)))];
}
function applyRoleWorkerResources(taskPackage, config, imports) {
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const role = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : pyTruthy(agent.role) ? agent.role : "");
  const capability = isRecord(agent.capability) ? pyStrip(pyStr(pyTruthy(agent.capability.name) ? agent.capability.name : "")) : "";
  const whitelist = resolveWorkerResources(config, role, capability);
  if (whitelist === null) return;
  const declared = taskToolAllowlist(taskPackage);
  const selection = [.../* @__PURE__ */ new Set([...whitelist.tools, ...defaultOnTools(imports)])];
  taskPackage.tool_contract.allowed = declared === null ? selection : declared.filter((name) => selection.includes(name));
  taskPackage.worker_resources = {
    extensions: whitelist.extensions,
    skills: whitelist.skills,
    project_skills: whitelist.project_skills,
    declared_tools: declared,
    source: { role, capability }
  };
}
function reviewExecutionProfile(taskPackage) {
  const extensions = isRecord(taskPackage?.extensions) ? taskPackage.extensions : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  return pyStr(pyTruthy(review.profile) ? review.profile : "");
}
function projectConditionalRequiredFiles(taskPackage) {
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const routeId2 = `${pyStr(Object.hasOwn(agent, "role") ? agent.role : "")}__${pyStr(Object.hasOwn(capability, "name") ? capability.name : "")}`;
  agent.required_files = conditionalRequiredFiles(taskPackage, profileFor(routeId2));
  return null;
}
function agentConfigEntryImpl(agentType) {
  return loadRoleConfig(agentType);
}
function agentConfigEntry(agentType) {
  return deps2.agentConfigEntry(agentType);
}
function piChildCatalogCommandImpl() {
  const configured = pyStrip(String(process8.env.PI_CONTROL_PI || ""));
  if (configured) {
    const suffix = path16.extname(configured).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(suffix)) {
      const node = shutilWhich("node");
      return node ? [node, configured] : [];
    }
    return [configured];
  }
  let executable = process8.platform === "win32" ? shutilWhich("pi.cmd") : shutilWhich("pi");
  if (!executable && process8.platform === "win32") executable = shutilWhich("pi");
  return executable ? [executable] : [];
}
function piChildCatalogCommand() {
  return deps2.piChildCatalogCommand();
}
function piChildModelExtensionProfileImpl() {
  if (pyStrip(String(process8.env.PI_CONTROL_PI || ""))) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: null };
  }
  let extensions;
  try {
    extensions = resolvePiChildModelExtensions();
  } catch (error) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: pySlice(String(error?.message ?? error), 500) };
  }
  if (!extensions.every((item) => typeof item === "string" && isAbsoluteLikePython(item) && isFile5(item))) {
    return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions: [], error: "model extension profile returned invalid paths" };
  }
  return { profile: PI_CHILD_MODEL_EXTENSION_PROFILE, extensions, error: null };
}
function piChildModelExtensionProfile() {
  if (!caches.piChildModelExtensionProfile.has("value")) {
    caches.piChildModelExtensionProfile.set("value", deps2.piChildModelExtensionProfile());
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
function _probePiChildModelCatalogUncached(targetCwd) {
  return deps2.probePiChildModelCatalogUncached(targetCwd);
}
function piChildCatalogCacheIdentity(targetCwd) {
  const command = piChildCatalogCommand();
  const extensionProfile = piChildModelExtensionProfile();
  const extensions = Array.isArray(extensionProfile.extensions) ? extensionProfile.extensions : [];
  const agentDir = resolvePiAgentDir();
  const configPaths = [
    ...extensions,
    ...CHILD_CATALOG_CONFIG_SURFACE.map((name) => path16.join(agentDir, ...String(name).split("/")))
  ];
  return {
    schema: CATALOG_CACHE_SCHEMA,
    platform: process8.platform,
    pi_control_pi: pyStrip(String(process8.env.PI_CONTROL_PI || "")),
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
  const override = pyStrip(String(process8.env.SUBAGENT_CATALOG_CACHE_DIR || ""));
  const cacheDir = override ? resolveLikePython(override) : path16.join(ROOT, ".runtime", "cockpit", "cache");
  return path16.join(cacheDir, CATALOG_CACHE_FILE_NAME);
}
function childCatalogFileLayerEnabled() {
  return deps2.probePiChildModelCatalogUncached === probePiChildModelCatalogUncachedImpl;
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
  const value = deps2.probePiChildModelCatalogUncached(key);
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
function probePiChildModelCatalog(targetCwd, options = {}) {
  return deps2.probePiChildModelCatalog(targetCwd, options);
}
function requirePiChildModel(model, targetCwd, options = {}) {
  const resolvedCwd = String(resolveLikePython(targetCwd));
  let catalog = probePiChildModelCatalog(resolvedCwd, options);
  if (catalog?.status === "ok" && cacheServedCatalogs.has(catalog) && !new Set(pyTruthy(catalog.models) ? catalog.models : []).has(model)) {
    catalog = probePiChildModelCatalogFresh(resolvedCwd, options);
  }
  if (catalog?.status !== "ok") {
    return {
      status: "unknown",
      source: catalog?.source ?? "Pi child catalog probe",
      warning: `Pi child model catalog probe failed: ${pyStr(catalog?.error || "unknown error")}; continuing to runner model validation`
    };
  }
  const available = new Set(pyTruthy(catalog.models) ? catalog.models : []);
  if (!available.has(model)) {
    throw new ToolError(
      `resolved model ${model} is not available in the Pi child model profile (${pyStr(catalog.source)}); available models: ${[...available].sort().join(", ") || "(none)"}; nothing was dispatched and no other model was substituted; choose a model from this list and retry`
    );
  }
  return { status: "available", source: pyStr(pyTruthy(catalog.source) ? catalog.source : "") };
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
function resolveAsyncModelSelection(taskPackage, modelOverride, effortOverride, extra = {}) {
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const agentType = pyStrip(pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : pyTruthy(agent.role) ? agent.role : ""));
  const capability = isRecord(agent.capability) ? pyStrip(pyStr(pyTruthy(agent.capability.name) ? agent.capability.name : "")) : "";
  return resolveRoleModelSelection(agentType, modelOverride, effortOverride, capability, extra);
}
function resolveAsyncRuntimeOptions(taskPackage, options = {}) {
  const {
    model = "",
    effort = "",
    pick = "",
    authorization = null,
    contextMode = "",
    runnerPath = "",
    taskRoot = "",
    targetCwd = "",
    executionProfile = "",
    stallSilenceMs = null,
    catalogCacheWrite = false
  } = options;
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const resolvedToolAllowlist = taskToolAllowlist(taskPackage);
  const warnings = [];
  const reviewNeedsNetwork = truthyText(taskPackage?.runtime_context?.network_needed);
  let reviewProfile = reviewExecutionProfile(taskPackage);
  if (reviewProfile === PROFILE && reviewNeedsNetwork) {
    reviewProfile = "evidence_assisted_v1";
    taskPackage.extensions.review_execution.profile = reviewProfile;
  }
  const evidenceOnly = reviewProfile === PROFILE;
  const semanticReview = reviewProfile === SEMANTIC_PROFILE;
  const acceptanceSynthesis = reviewProfile === ACCEPTANCE_SYNTHESIS_PROFILE;
  const networkReview = reviewNeedsNetwork && (reviewProfile === "evidence_assisted_v1" || isStaticReview(taskPackage));
  if (networkReview && !semanticReview && !acceptanceSynthesis) warnings.push("network_needed=yes\uFF1A\u4F7F\u7528evidence_assisted_v1\uFF1B\u5DE5\u5177\u6309\u58F0\u660E\u6216Pi\u914D\u7F6E\u63D0\u4F9B\uFF0C\u4E0D\u81EA\u52A8\u8FFD\u52A0\u53D6\u8BC1\u5DE5\u5177\u3002");
  let effectiveExecutionProfile = evidenceOnly ? PROFILE : pyTruthy(executionProfile) ? executionProfile : "standard";
  if (!["standard", "simulation", PROFILE].includes(effectiveExecutionProfile)) {
    throw new ToolError(`unsupported async execution_profile: ${effectiveExecutionProfile}`);
  }
  const effectiveTargetCwd = resolveLikePython(pyTruthy(targetCwd) ? targetCwd : ROOT);
  if (!isDirectory2(effectiveTargetCwd)) throw new ToolError(`async target_cwd does not exist: ${effectiveTargetCwd}`);
  const controllerRuntime = resolveLikePython(path16.join(ROOT, ".runtime"));
  const effectiveTaskRoot = resolveLikePython(
    pyTruthy(taskRoot) ? taskRoot : path16.join(controllerRuntime, "cockpit", "async_tasks")
  );
  if (!pyIsRelativeTo(effectiveTaskRoot, controllerRuntime)) {
    throw new ToolError("async task_root must stay inside the controller repository .runtime");
  }
  let effectiveRunnerPath = "";
  const requestedRunnerPath = pyTruthy(runnerPath) ? runnerPath : PI_ASYNC_RUNNER_SENTINEL;
  if (requestedRunnerPath === PI_ASYNC_RUNNER_SENTINEL) {
    effectiveRunnerPath = requestedRunnerPath;
  } else if (pyTruthy(requestedRunnerPath)) {
    effectiveRunnerPath = String(resolveLikePython(requestedRunnerPath));
    if (!isFile5(effectiveRunnerPath)) throw new ToolError(`async runner does not exist: ${effectiveRunnerPath}`);
  }
  const extensions = isRecord(taskPackage?.extensions) ? taskPackage.extensions : {};
  const crossRepo = isRecord(extensions.cross_repo_acceptance) ? extensions.cross_repo_acceptance : {};
  let resultMode = pyStr(pyTruthy(crossRepo.result_mode) ? crossRepo.result_mode : "");
  if (resultMode && !CROSS_REPO_RESULT_MODES.has(resultMode)) {
    throw new ToolError(
      "extensions.cross_repo_acceptance.result_mode must be one of " + sortedStrings(CROSS_REPO_RESULT_MODES).join(" | ")
    );
  }
  if (!pySamePath(effectiveTargetCwd, resolveLikePython(ROOT)) && !resultMode) {
    resultMode = "read_only_audit";
    crossRepo.result_mode = resultMode;
    extensions.cross_repo_acceptance = crossRepo;
    taskPackage.extensions = extensions;
    warnings.push("\u8DE8\u4ED3result_mode\u7F3A\u7701\u4E3Aread_only_audit\uFF1B\u9700\u8981\u5B9E\u65BD\u4E1A\u52A1\u6539\u52A8\u65F6\u663E\u5F0F\u9009\u62E9real_rerun\u53CA\u5BF9\u5E94\u5199\u5165\u8303\u56F4\u3002");
  }
  if (resultMode === "simulated_planning" && effectiveExecutionProfile !== "simulation") {
    warnings.push(`result_mode=simulated_planning\uFF1Aexecution_profile\u7531${effectiveExecutionProfile}\u63A8\u5BFC\u4E3Asimulation\u3002`);
    effectiveExecutionProfile = "simulation";
  }
  let simulationProfile = null;
  if (effectiveExecutionProfile === "simulation") {
    const simulation = isRecord(crossRepo.simulation) ? crossRepo.simulation : {};
    const role = pyStrip(pyStr(pyTruthy(simulation.role) ? simulation.role : ""));
    const persona = simulation.persona;
    if (resultMode !== "simulated_planning" || !role || !isRecord(persona) || !pyTruthy(persona)) {
      throw new ToolError(
        "simulation requires result_mode=simulated_planning and non-empty extensions.cross_repo_acceptance.simulation.role/persona"
      );
    }
    simulationProfile = { role, persona: structuredClone(persona) };
  }
  const modelSelection = resolveAsyncModelSelection(taskPackage, model, effort, { pick, authorization });
  if (modelSelection.selection && extensions.resource_config_fingerprint) {
    modelSelection.selection.config_source = {
      ...modelSelection.selection.config_source,
      resource_config_fingerprint: extensions.resource_config_fingerprint
    };
  }
  const usesDefaultPiRunner = requestedRunnerPath === PI_ASYNC_RUNNER_SENTINEL;
  const catalogProbeOptions = { cacheWrite: Boolean(catalogCacheWrite) };
  const webExtension = { status: "configured_resources", source: "Pi user configuration" };
  if (usesDefaultPiRunner) {
    modelSelection.child_model = requirePiChildModel(
      pyStr(pyTruthy(modelSelection.primary_model) ? modelSelection.primary_model : ""),
      effectiveTargetCwd,
      catalogProbeOptions
    );
  } else {
    modelSelection.child_model = { status: "not_checked", source: "custom_runner" };
  }
  return {
    agent_type: pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : pyTruthy(agent.role) ? agent.role : ""),
    executor: "pi",
    execution_profile: effectiveExecutionProfile,
    context_mode: evidenceOnly ? "isolated" : pyTruthy(contextMode) ? contextMode : "project-aware",
    runner_path: effectiveRunnerPath,
    target_cwd: effectiveTargetCwd,
    task_root: effectiveTaskRoot,
    result_mode: resultMode,
    simulation_profile: simulationProfile,
    ...warnings.length ? { warnings } : {},
    tool_allowlist: resolvedToolAllowlist,
    tool_allowlist_source: resolvedToolAllowlist === null ? "pi_configured_tools" : "task_package.tool_contract.allowed",
    web_extension: webExtension,
    model_selection: modelSelection,
    stall_silence_ms: stallSilenceMs
  };
}
function currentDispatchPhase() {
  return dispatchPhaseState.phase;
}
function markDispatchPhase(phase) {
  dispatchPhaseState.phase = phase;
  process8.stderr.write(`[dispatch-phase] seed=${dispatchPhaseState.seedIndex} phase=${phase}
`);
  return null;
}
function prepareAsyncSubagent(pkg, options = {}) {
  const {
    model = "",
    effort = "",
    pick = "",
    authorization = null,
    contextMode = "",
    runnerPath = "",
    taskRoot = "",
    targetCwd = "",
    executionProfile = "",
    stallSilenceMs = null,
    catalogCacheWrite = false,
    resolvedOptions = null,
    submitter = null,
    batchId = "",
    sliceId = "",
    displayTitle = "",
    action = "submit",
    originId = "",
    reviewEvidenceBuilder = null,
    budget = null
  } = options;
  let deferFinalRuntimeResolution = Boolean(options.deferFinalRuntimeResolution);
  const normalizedAction = pyStrip(pyStr(pyTruthy(action) ? action : "submit")).toLowerCase();
  if (!["prepare", "submit"].includes(normalizedAction)) {
    throw new ToolError(`async preparation does not support action=${pyRepr(normalizedAction)}`);
  }
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId2 = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const staticReview = isStaticReview(taskPackage);
  deferFinalRuntimeResolution = Boolean(
    deferFinalRuntimeResolution || staticReview && ["prepare", "submit"].includes(normalizedAction)
  );
  let opts;
  if (deferFinalRuntimeResolution) {
    const supplied = { ...resolvedOptions || {} };
    const selection = isRecord(supplied.model_selection) ? supplied.model_selection : {};
    const agentObject = isRecord(taskPackage.agent) ? taskPackage.agent : {};
    opts = {
      agent_type: pyStr(pyTruthy(supplied.agent_type) ? supplied.agent_type : pyTruthy(agentObject.runtime_role) ? agentObject.runtime_role : pyTruthy(agentObject.role) ? agentObject.role : ""),
      executor: "pi",
      target_cwd: lexicalAbsolute(pyTruthy(targetCwd) ? targetCwd : pyTruthy(supplied.target_cwd) ? supplied.target_cwd : ROOT),
      task_root: lexicalAbsolute(pyTruthy(taskRoot) ? taskRoot : pyTruthy(supplied.task_root) ? supplied.task_root : PROJECT_ASYNC_TASK_ROOT),
      runner_path: pyTruthy(runnerPath) ? runnerPath : pyStr(pyTruthy(supplied.runner_path) ? supplied.runner_path : ""),
      model_selection: {
        primary_model: pyTruthy(model) ? model : pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : ""),
        primary_effort: pyTruthy(effort) ? effort : pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "")
      }
    };
  } else if (resolvedOptions !== null && resolvedOptions !== void 0) {
    opts = { ...resolvedOptions };
  } else {
    opts = resolveAsyncRuntimeOptions(taskPackage, {
      model,
      effort,
      pick,
      authorization,
      contextMode,
      runnerPath,
      taskRoot,
      targetCwd,
      executionProfile,
      stallSilenceMs,
      catalogCacheWrite
    });
  }
  const stableSelection = isRecord(opts.model_selection) ? opts.model_selection : {};
  const stableModel = pyTruthy(model) ? model : pyStr(pyTruthy(stableSelection.primary_model) ? stableSelection.primary_model : "");
  const stableEffort = pyTruthy(effort) ? effort : pyStr(pyTruthy(stableSelection.primary_effort) ? stableSelection.primary_effort : "");
  const stableRunnerPath = pyTruthy(runnerPath) ? runnerPath : pyStr(pyTruthy(opts.runner_path) ? opts.runner_path : "");
  const stableTaskRoot = pyTruthy(taskRoot) ? taskRoot : pyStr(pyTruthy(opts.task_root) ? opts.task_root : "");
  const stableTargetCwd = pyTruthy(targetCwd) ? targetCwd : pyStr(pyTruthy(opts.target_cwd) ? opts.target_cwd : "");
  const effectiveOriginId = pyStr(originId);
  const dispatchEnvelopeFor = (resolved) => {
    const selection = isRecord(resolved.model_selection) ? resolved.model_selection : {};
    return {
      contract_version: ASYNC_DISPATCH_CONTRACT_VERSION,
      // producer_root 是任务/临时状态归属根（项目本地），不是运行包根；运行资产由 entryDir/checker 策略解析。
      producer_root: String(ROOT),
      origin_thread_id: effectiveOriginId,
      target_cwd: String(pyTruthy(resolved.target_cwd) ? resolved.target_cwd : ROOT),
      task_file: "",
      task_root: String(pyTruthy(resolved.task_root) ? resolved.task_root : PROJECT_ASYNC_TASK_ROOT),
      runner_path: pyStr(pyTruthy(resolved.runner_path) ? resolved.runner_path : "") || null,
      runtime_role: pyStr(pyTruthy(resolved.agent_type) ? resolved.agent_type : ""),
      model: pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") || null,
      effort: pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") || null,
      ...isRecord(selection.selection) ? { selection: selection.selection } : {},
      context_mode: pyStr(pyTruthy(resolved.context_mode) ? resolved.context_mode : "project-aware"),
      execution_profile: pyStr(pyTruthy(resolved.execution_profile) ? resolved.execution_profile : "standard"),
      result_mode: pyStr(pyTruthy(resolved.result_mode) ? resolved.result_mode : "") || null,
      simulation: resolved.simulation_profile ?? null,
      stall_silence_ms: resolved.stall_silence_ms ?? null,
      // 种子 budget 经 prepareDispatch 传入；任务包本身不携带 budget。
      budget: isRecord(budget) && Object.keys(budget).length ? budget : isRecord(taskPackage.budget) ? taskPackage.budget : {},
      batch_id: pyTruthy(batchId) ? batchId : null,
      slice_id: pyTruthy(sliceId) ? sliceId : null,
      display_title: clampDisplayTitle(pyTruthy(displayTitle) ? displayTitle : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId2))
    };
  };
  let dispatchEnvelope = deferFinalRuntimeResolution ? null : dispatchEnvelopeFor(opts);
  const reviewHolder = {};
  const buildTaskMaterial = (packagePath2) => renderTaskMaterialFile(packagePath2);
  const buildReviewEvidence = (materialRoot, _preparedPackage) => {
    if (reviewEvidenceBuilder !== null && reviewEvidenceBuilder !== void 0) {
      const value = reviewEvidenceBuilder(materialRoot, _preparedPackage);
      reviewHolder.value = value;
      return value;
    }
    const evidence = deps2.attachReviewEvidence(pkg, {
      execute: true,
      outputPath: path16.join(String(materialRoot), "review-evidence.json")
    });
    reviewHolder.value = evidence;
    return { writes_performed: pyTruthy(evidence) ? ["review-evidence.json"] : [] };
  };
  const shouldWriteEvidence = isStaticReview(taskPackage);
  const finalizeAfterEvidence = (_materialRoot, _preparedPackage) => {
    opts = resolveAsyncRuntimeOptions(taskPackage, {
      model: stableModel,
      effort: stableEffort,
      pick,
      authorization,
      contextMode,
      runnerPath: stableRunnerPath,
      taskRoot: stableTaskRoot,
      targetCwd: stableTargetCwd,
      executionProfile,
      stallSilenceMs,
      // 该回调只在 prepare/submit 路径执行：允许文件层落盘。
      catalogCacheWrite: true
    });
    lintOrFail(pkg);
    dispatchEnvelope = dispatchEnvelopeFor(opts);
    return { runtime_options: opts, dispatch_envelope: dispatchEnvelope };
  };
  let descriptor;
  try {
    const selection = isRecord(opts.model_selection) ? opts.model_selection : null;
    descriptor = deps2.compilePreparedDispatch(pkg, {
      producerRoot: ROOT,
      resolvedRuntimeOptions: {
        ...opts,
        runtime_role: pyStr(pyTruthy(opts.agent_type) ? opts.agent_type : ""),
        model: selection ? pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") : "",
        effort: selection ? pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") : "",
        runner_path: pyStr(pyTruthy(opts.runner_path) ? opts.runner_path : ""),
        batch_id: pyTruthy(batchId) ? batchId : null,
        slice_id: pyTruthy(sliceId) ? sliceId : null,
        display_title: clampDisplayTitle(pyTruthy(displayTitle) ? displayTitle : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId2))
      },
      dispatchEnvelope,
      taskMaterialBuilder: buildTaskMaterial,
      reviewEvidenceBuilder: shouldWriteEvidence ? buildReviewEvidence : null,
      postMaterialCallback: deferFinalRuntimeResolution ? finalizeAfterEvidence : null,
      originId: effectiveOriginId,
      batchId: pyTruthy(batchId) ? batchId : null,
      sliceId: pyTruthy(sliceId) ? sliceId : null,
      displayTitle: clampDisplayTitle(pyTruthy(displayTitle) ? displayTitle : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId2))
    });
  } catch (error) {
    if (isPyCaughtError(error, /* @__PURE__ */ new Set(["PreparedDispatchError", "OSError", "ValueError"]))) {
      throw new ToolError(`prepared dispatch compilation failed: ${error.message}`);
    }
    throw error;
  }
  let verifiedDescriptor;
  try {
    verifiedDescriptor = deps2.verifyPreparedDispatch(pyGetItem(descriptor, "descriptor_file"));
  } catch (error) {
    if (isPyCaughtError(error, /* @__PURE__ */ new Set(["PreparedDispatchError", "OSError", "ValueError"]))) {
      throw new ToolError(`prepared dispatch verification failed: ${error.message}`);
    }
    throw error;
  }
  const agentType = pyStr(pyTruthy(opts.agent_type) ? opts.agent_type : "");
  const effectiveExecutionProfile = pyStr(pyTruthy(opts.execution_profile) ? opts.execution_profile : "standard");
  const effectiveContextMode = pyStr(pyTruthy(opts.context_mode) ? opts.context_mode : "project-aware");
  const effectiveTaskRoot = String(pyGetItem(opts, "task_root"));
  const resultMode = pyStr(pyTruthy(opts.result_mode) ? opts.result_mode : "");
  const modelSelection = { ...pyTruthy(opts.model_selection) ? opts.model_selection : {} };
  const primaryModel = pyStr(pyTruthy(modelSelection.primary_model) ? modelSelection.primary_model : "");
  const primaryEffort = pyStr(pyTruthy(modelSelection.primary_effort) ? modelSelection.primary_effort : "");
  const packagePath = String(pyGetItem(verifiedDescriptor, "package_file"));
  const taskMaterialPath = String(pyGetItem(verifiedDescriptor, "task_file"));
  const dispatchEnvelopePath = String(pyGetItem(verifiedDescriptor, "dispatch_file"));
  const baseResult = {
    status: "ok",
    action: normalizedAction,
    delivery_mode: "async_subagent",
    batch_id: pyTruthy(batchId) ? batchId : null,
    slice_id: pyTruthy(sliceId) ? sliceId : null,
    display_title: clampDisplayTitle(pyTruthy(displayTitle) ? displayTitle : pyStr(pyTruthy(taskPackage.goal) ? taskPackage.goal : packageId2)),
    origin_thread_id: pyTruthy(effectiveOriginId) ? effectiveOriginId : null,
    dispatch_contract_version: ASYNC_DISPATCH_CONTRACT_VERSION,
    package_id: packageId2,
    agent_type: agentType,
    executor: "pi",
    task_package_path: rel(packagePath),
    task_material_path: rel(taskMaterialPath),
    dispatch_envelope_path: rel(dispatchEnvelopePath),
    package_file: verifiedDescriptor.package_file,
    task_file: verifiedDescriptor.task_file,
    dispatch_file: verifiedDescriptor.dispatch_file,
    descriptor_file: verifiedDescriptor.descriptor_file,
    preparation_id: verifiedDescriptor.preparation_id,
    material_root: verifiedDescriptor.material_root,
    descriptor: verifiedDescriptor,
    writes_performed: [...pyList(pyTruthy(verifiedDescriptor.writes_performed) ? verifiedDescriptor.writes_performed : [])],
    tool_allowlist: opts.tool_allowlist ?? null,
    tool_allowlist_source: pyStr(pyTruthy(opts.tool_allowlist_source) ? opts.tool_allowlist_source : ""),
    context_mode: effectiveContextMode,
    review_execution_profile: reviewExecutionProfile(taskPackage) || null,
    execution_profile: effectiveExecutionProfile,
    result_mode: resultMode || null,
    async_model_selection: modelSelection,
    ...opts.warnings?.length ? { warnings: opts.warnings } : {},
    model: primaryModel,
    effort: primaryEffort
  };
  if (normalizedAction === "prepare") baseResult.state = "prepared";
  if (reviewHolder.value !== void 0 && reviewHolder.value !== null) {
    baseResult.review_evidence = reviewHolder.value;
  }
  if (normalizedAction === "prepare") return baseResult;
  markDispatchPhase("submit");
  const submit = submitter || deps2.callAsyncInternalAdapter;
  const receipt = submit("submit-prepared", { dispatch_file: verifiedDescriptor.dispatch_file });
  if (!isRecord(receipt)) throw new ToolError("async transport returned a malformed receipt; task_id is ambiguous");
  const rawTaskId = receipt.task_id;
  const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
  if (!_validTaskId(taskId)) {
    throw new ToolError("async transport returned an empty or malformed task_id; task submission is ambiguous");
  }
  const taskDir = pathlibJoin(effectiveTaskRoot, taskId);
  Object.assign(baseResult, {
    task_id: taskId,
    task_dir: String(taskDir),
    status_path: String(path16.join(taskDir, "status.json")),
    handoff_path: String(path16.join(taskDir, "handoff.md")),
    report_path: String(path16.join(taskDir, "report.md")),
    wait_tool_arguments: { task_id: taskId, timeout_ms: 6e4 },
    get_tool_arguments: { task_ids: [taskId], detail: "compact" },
    result_tool_arguments: { task_id: taskId },
    spawn_payload: renderAsyncTaskPayload(packagePath, taskId)
  });
  return baseResult;
}
function taskPackageOutputSummary(taskPackage) {
  const expected = isRecord(taskPackage?.expected_output) ? taskPackage.expected_output : {};
  const handoff = isRecord(taskPackage?.handoff_contract) ? taskPackage.handoff_contract : {};
  const scope = isRecord(taskPackage?.scope) ? taskPackage.scope : {};
  const scopeWrite = [];
  for (const item of pyList(Object.hasOwn(scope, "write") ? scope.write : [])) {
    if (typeof item === "string" && !scopeWrite.includes(item)) scopeWrite.push(item);
  }
  const expectedCandidates = ["resolved_file_path", "file_path", "path"].filter((key) => pyTruthy(expected[key])).map((key) => pyStr(pyTruthy(expected[key]) ? expected[key] : ""));
  const handoffCandidates = ["resolved_handoff_file", "handoff_file"].filter((key) => pyTruthy(handoff[key])).map((key) => pyStr(pyTruthy(handoff[key]) ? handoff[key] : ""));
  const declared = new Set([...expectedCandidates, ...handoffCandidates].map((item) => item.split("\\").join("/")));
  const extraWrites = scopeWrite.filter((item) => !declared.has(item.split("\\").join("/")));
  let note = null;
  if (extraWrites.length) {
    note = "scope.write_extra entries are additional allowed writes; they do not override expected_output.file_path. Set expected_output.file_path/resolved_file_path explicitly when a reducer or report must land at a specific path.";
  }
  return {
    expected_report_path: expectedCandidates.length ? expectedCandidates[0] : null,
    expected_handoff_path: handoffCandidates.length ? handoffCandidates[0] : null,
    expected_output: expected,
    handoff_contract: handoff,
    scope_write: scopeWrite,
    extra_write_paths: extraWrites,
    write_extra_note: note
  };
}
function prepareDryRun(pkg, delivery, resolvedDelivery, readiness, resolvedOptions = null) {
  const taskPackage = pyGetItem(pkg, "task_package");
  readRequiredFiles(taskPackage);
  roleDeveloperInstructions(taskPackage);
  const packageId2 = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const agentType = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : pyTruthy(agent.role) ? agent.role : "");
  const wouldDeliveryMap = { "async-subagent": "async_subagent", direct: "direct_message" };
  const result = {
    status: "ok",
    dry_run: true,
    delivery_mode: `${delivery}_dry_run`,
    resolved_delivery: resolvedDelivery,
    would_delivery_mode: Object.hasOwn(wouldDeliveryMap, resolvedDelivery) ? wouldDeliveryMap[resolvedDelivery] : resolvedDelivery,
    delivery_readiness: readiness,
    package_id: packageId2,
    agent_type: agentType,
    business_output: taskPackageOutputSummary(taskPackage),
    spawn_payload: "DRY_RUN_ONLY: no async task or dispatch payload registered; rerun with --action prepare/submit after dispatch is authorized",
    writes_performed: []
  };
  if (resolvedOptions !== null && resolvedOptions !== void 0) {
    const selection = isRecord(resolvedOptions.model_selection) ? resolvedOptions.model_selection : {};
    result.async_preview = {
      executor: resolvedOptions.executor ?? null,
      runner_path: pyStr(pyTruthy(resolvedOptions.runner_path) ? resolvedOptions.runner_path : "") || null,
      model: pyStr(pyTruthy(selection.primary_model) ? selection.primary_model : "") || null,
      effort: pyStr(pyTruthy(selection.primary_effort) ? selection.primary_effort : "") || null,
      model_source: selection.model_source ?? null,
      effort_source: selection.effort_source ?? null,
      child_model: selection.child_model ?? null,
      ...isRecord(selection.selection) ? { selection: selection.selection } : {}
    };
  }
  return result;
}
function normalizeDispatchAction(action = "") {
  const requested = pyStrip(pyStr(pyTruthy(action) ? action : "")).toLowerCase();
  if (requested && !["preview", "prepare", "submit"].includes(requested)) {
    throw new ToolError("action must be one of preview, prepare, submit");
  }
  return requested || "submit";
}
function legacyOriginId() {
  return String(process8.env.CODEX_THREAD_ID || "");
}
function prepareDispatch(seed, delivery, options = {}) {
  const {
    action = "",
    asyncModel = "",
    asyncEffort = "",
    asyncPick = "",
    asyncAuthorization = null,
    asyncContextMode = "",
    asyncRunnerPath = "",
    asyncTaskRoot = "",
    asyncTargetCwd = "",
    asyncExecutionProfile = "",
    asyncStallSilenceMs = null,
    asyncBatchId = "",
    asyncSliceId = "",
    asyncDisplayTitle = "",
    asyncSubmitter = null,
    originId = null
  } = options;
  markDispatchPhase("seed");
  const normalizedAction = normalizeDispatchAction(action);
  const preview = normalizedAction === "preview";
  if (asyncTargetCwd) {
    seed = {
      ...seed,
      runtime_context: {
        ...seed.runtime_context ?? {},
        target_repo: String(resolveLikePython(asyncTargetCwd))
      }
    };
  }
  const pkg = buildPackage(seed);
  markDispatchPhase("lint");
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  const compiledTask = pyGetItem(pkg, "task_package");
  compiledTask.extensions.model_config = { global_root: modelConfigSources().global_root, project_root: ROOT };
  const importedResources = loadWorkerResourcesConfig(path16.join(RUNTIME_ROOT, "ops", "templates", "worker-resources.json"));
  applyRoleWorkerResources(compiledTask, loadSelectionConfig(modelConfigSources()), importedResources);
  const resourceSnapshot = {
    tools: importedResources.tools,
    extensions: importedResources.extensions,
    skills: importedResources.skills,
    required_tools: importedResources.required_tools
  };
  compiledTask.extensions.resource_config_fingerprint = `sha256:${createHash5("sha256").update(JSON.stringify(resourceSnapshot)).digest("hex")}`;
  markDispatchPhase("compile");
  let resolvedDelivery;
  let readiness;
  if (normalizedAction === "prepare" || preview && delivery === "async-subagent") {
    resolvedDelivery = "async-subagent";
    readiness = { status: "not_checked", issues: [] };
  } else {
    [resolvedDelivery, readiness] = deps2.resolveDelivery(delivery);
  }
  const staticReview = isStaticReview(pyGetItem(pkg, "task_package"));
  const deferFinalRuntimeResolution = resolvedDelivery === "async-subagent" && ["prepare", "submit"].includes(normalizedAction) && staticReview;
  const reviewEvidence = preview ? deps2.attachReviewEvidence(pkg, { execute: false }) : null;
  let resolvedAsyncOptions = null;
  if (["preview", "prepare", "submit"].includes(normalizedAction) && resolvedDelivery === "async-subagent" && !deferFinalRuntimeResolution) {
    resolvedAsyncOptions = resolveAsyncRuntimeOptions(pyGetItem(pkg, "task_package"), {
      model: asyncModel,
      effort: asyncEffort,
      pick: asyncPick,
      authorization: asyncAuthorization,
      contextMode: asyncContextMode,
      runnerPath: asyncRunnerPath,
      taskRoot: asyncTaskRoot,
      targetCwd: asyncTargetCwd,
      executionProfile: asyncExecutionProfile,
      stallSilenceMs: asyncStallSilenceMs,
      // preview 只读；prepare/submit 才允许文件层落盘。
      catalogCacheWrite: normalizedAction !== "preview"
    });
    const effectiveTarget = resolveLikePython(pyGetItem(resolvedAsyncOptions, "target_cwd"));
    if (!pySamePath(effectiveTarget, resolveLikePython(ROOT))) {
      const taskPackage = pyGetItem(pkg, "task_package");
      taskPackage.runtime_context.target_repo = String(effectiveTarget);
      lintOrFail(pkg);
    }
  }
  const layers = readScopeLayersFromSeed(seed);
  if (layers !== null) pyGetItem(pkg, "task_package").read_scope_layers = layers;
  const scopePreflightBase = asyncTargetCwd ? resolveLikePython(asyncTargetCwd) : resolvedAsyncOptions !== null ? resolveLikePython(String(pyGetItem(resolvedAsyncOptions, "target_cwd"))) : ROOT;
  const scopePreflight = computeScopePreflight(
    preflightReadPaths(layers, pyGetItem(pyGetItem(pyGetItem(pkg, "task_package"), "scope"), "read")),
    { baseRoot: scopePreflightBase }
  );
  const scopeDiagnostics = enforceScopePreflight(scopePreflight);
  pyGetItem(pkg, "task_package").scope_preflight = scopePreflight;
  if (scopeDiagnostics.length) {
    pyGetItem(pkg, "task_package").known_facts.push(...scopeDiagnostics);
  }
  const budget = seedBudget(seed);
  const annotate = (result2) => {
    if (!Object.hasOwn(result2, "action")) result2.action = normalizedAction;
    result2.scope_preflight = scopePreflight;
    result2.business_output = taskPackageOutputSummary(pyGetItem(pkg, "task_package"));
    const warnings = [...new Set([
      ...scopeDiagnostics,
      ...result2.warnings || [],
      ...resolvedAsyncOptions?.warnings || [],
      result2.async_model_selection?.child_model?.warning,
      resolvedAsyncOptions?.model_selection?.child_model?.warning
    ].filter(Boolean))];
    if (warnings.length) result2.warnings = warnings;
    if (asyncBatchId) {
      result2.batch_id = asyncBatchId;
      result2.slice_id = asyncSliceId;
    }
    result2.display_title = clampDisplayTitle(asyncDisplayTitle || sliceMetadata(seed, 0)[1]);
    if (layers !== null) {
      result2.read_scope_layers = layers;
      result2.read_scope_layers_directive = renderReadScopeLayers(layers);
    }
    if (pyTruthy(budget)) {
      result2.budget = budget;
      result2.budget_enforcement = { max_elapsed_minutes: "enforced_per_attempt" };
    }
    if (preview && reviewEvidence !== null && reviewEvidence !== void 0) {
      result2.review_evidence = reviewEvidence;
    }
    return result2;
  };
  if (preview) return annotate(prepareDryRun(pkg, delivery, resolvedDelivery, readiness, resolvedAsyncOptions));
  let result;
  if (resolvedDelivery === "async-subagent") {
    result = prepareAsyncSubagent(pkg, {
      model: asyncModel,
      effort: asyncEffort,
      pick: asyncPick,
      authorization: asyncAuthorization,
      contextMode: asyncContextMode,
      runnerPath: asyncRunnerPath,
      taskRoot: asyncTaskRoot,
      targetCwd: asyncTargetCwd,
      executionProfile: asyncExecutionProfile,
      stallSilenceMs: asyncStallSilenceMs,
      budget,
      catalogCacheWrite: normalizedAction !== "preview",
      resolvedOptions: resolvedAsyncOptions,
      submitter: asyncSubmitter,
      batchId: asyncBatchId,
      sliceId: asyncSliceId,
      displayTitle: asyncDisplayTitle,
      action: normalizedAction,
      deferFinalRuntimeResolution,
      originId: normalizedAction === "prepare" && (originId === null || originId === void 0) ? "" : originId === null || originId === void 0 ? legacyOriginId() : pyStr(originId)
    });
  } else if (resolvedDelivery === "direct") {
    throw new ToolError("direct subagent dispatch is disabled; use --delivery auto/async-subagent so dispatch goes through MCP async");
  } else if (resolvedDelivery === "unavailable") {
    const issues = pyList(pyTruthy(readiness?.issues) ? readiness.issues : []).join("; ");
    throw new ToolError(`async subagent MCP dispatch unavailable; subagent dispatch not submitted: ${issues || "unknown readiness issue"}`);
  } else {
    throw new ToolError(`unknown delivery: ${resolvedDelivery}`);
  }
  annotate(result);
  result.requested_delivery = delivery;
  result.resolved_delivery = resolvedDelivery;
  result.delivery_readiness = readiness;
  return result;
}
function makeBatchId(_seeds) {
  const now = clock.now();
  const pad = (value, width) => String(value).padStart(width, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}${pad(now.getUTCMilliseconds(), 3)}Z`;
  return `batch-${stamp}-${ids.uuidHex().slice(0, 12)}`;
}
function sliceMetadata(seed, index) {
  const sliceId = pyStrip(pyStr(
    pyTruthy(seed?.slice_id) ? seed.slice_id : pyTruthy(seed?.slug) ? seed.slug : `slice-${String(index + 1).padStart(2, "0")}`
  ));
  const displayTitle = pyStrip(pyStr(
    pyTruthy(seed?.title) ? seed.title : pyTruthy(seed?.goal) ? seed.goal : sliceId
  ));
  return [pySlice(sliceId, 120), pySlice(displayTitle, 240)];
}
function clampDisplayTitle(text3, limitBytes = 120) {
  const encoded = Buffer.from(pyStr(text3), "utf8").subarray(0, limitBytes);
  return pyStrip(new TextDecoder("utf-8", { fatal: false }).decode(encoded).replace(/\uFFFD+$/, ""));
}
function prepareBatchDispatch(seeds, delivery, options = {}) {
  const { batchId = "", ...kwargs } = options;
  const batchAction = normalizeDispatchAction(pyStr(pyTruthy(kwargs.action) ? kwargs.action : ""));
  const resolvedBatchId = pySlice(pyStrip(String(batchId ?? "")) || makeBatchId(seeds), 120);
  const conflicts = batchWriteConflicts(seeds);
  const conflictIndexes = new Set(conflicts.flatMap((item) => [
    Number(item.left_seed_index),
    Number(item.right_seed_index)
  ]));
  const dispatches = [];
  const failedIndexes = [];
  seeds.forEach((seed, idx) => {
    const [currentSliceId, currentTitle] = sliceMetadata(seed, idx);
    if (conflictIndexes.has(idx + 1)) {
      failedIndexes.push(idx + 1);
      dispatches.push({
        status: "failed",
        seed_index: idx + 1,
        phase: "seed",
        batch_id: resolvedBatchId,
        slice_id: currentSliceId,
        display_title: currentTitle,
        error: "batch write conflict preflight failed"
      });
      return;
    }
    const previousSeedIndex = dispatchPhaseState.seedIndex;
    dispatchPhaseState.seedIndex = idx + 1;
    try {
      const outcome = prepareDispatch(seed, delivery, {
        ...kwargs,
        asyncBatchId: resolvedBatchId,
        asyncSliceId: currentSliceId,
        asyncDisplayTitle: currentTitle
      });
      dispatches.push(outcome);
    } catch (error) {
      if (!isPyCaughtError(error, /* @__PURE__ */ new Set(["ToolError", "KeyError", "ValueError", "OSError"]))) {
        dispatchPhaseState.seedIndex = previousSeedIndex;
        throw error;
      }
      failedIndexes.push(idx + 1);
      const phase = dispatchPhaseState.phase;
      dispatches.push({
        status: "failed",
        seed_index: idx + 1,
        phase,
        batch_id: resolvedBatchId,
        slice_id: currentSliceId,
        display_title: currentTitle,
        error: `[${phase}] ${error.message}`
      });
    } finally {
      dispatchPhaseState.seedIndex = previousSeedIndex;
    }
  });
  const committedTaskIds = dispatches.filter((item) => item.status === "ok" && pyTruthy(item.task_id)).map((item) => item.task_id);
  return {
    status: conflicts.length && conflictIndexes.size === seeds.length ? "failed" : failedIndexes.length ? "partial" : "ok",
    action: batchAction,
    batch_id: resolvedBatchId,
    count: dispatches.length,
    dispatches,
    failed_seed_indexes: failedIndexes,
    not_submitted_seed_indexes: [],
    committed_task_ids: committedTaskIds,
    ...conflicts.length ? { batch_write_conflicts: conflicts } : {}
  };
}
async function attachAgentPanelLaunch(result, { dryRun, ensure = null } = {}) {
  const ensureFn = ensure || deps2.ensureAgentPanel;
  if (dryRun) return result;
  let taskIds = [...pyList(pyTruthy(result?.committed_task_ids) ? result.committed_task_ids : [])];
  if (result?.status === "ok" && result?.action !== "prepare" && result?.delivery_mode === "async_subagent" && pyTruthy(result?.task_id)) {
    taskIds = [pyStr(pyGetItem(result, "task_id"))];
  }
  if (!taskIds.length) return result;
  try {
    result.agent_panel_launch = await ensureFn();
  } catch (error) {
    result.agent_panel_launch = {
      status: "failed",
      error: String(error?.message ?? error),
      log_path: BUILD_LOG_PATH
    };
  }
  return result;
}
function agentPanelLaunchText(result) {
  const launch = isRecord(result?.agent_panel_launch) ? result.agent_panel_launch : null;
  if (!pyTruthy(launch)) return "";
  const status = pyStr(pyTruthy(launch.status) ? launch.status : "unknown");
  if (status === "failed") {
    return `

Agent Panel \u542F\u52A8\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u5DF2\u63D0\u4EA4\u4EFB\u52A1\uFF09\uFF1A${pyTruthy(launch.error) ? launch.error : "\u67E5\u770B launcher \u65E5\u5FD7"}`;
  }
  return `

Agent Panel\uFF1A${status}`;
}
function checkRouteCard(routeId2) {
  const pkg = buildPackage(expandSeed(exampleSeed(routeId2)));
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  return null;
}
function prepareDirectPreview(seed, { asyncModel = "" } = {}) {
  const pkg = buildPackage(seed);
  projectConditionalRequiredFiles(pyGetItem(pkg, "task_package"));
  lintOrFail(pkg);
  return prepareDirect(pkg);
}
async function selfTest2() {
  const selftest = await init_dispatch_prepare_selftest().then(() => dispatch_prepare_selftest_exports);
  return selftest.selfTest();
}
var PREFLIGHT_FILE_THRESHOLD, PREFLIGHT_BYTES_THRESHOLD, PREFLIGHT_LARGE_FILE_BYTES, PREFLIGHT_WALK_SKIP_DIRS, PREFLIGHT_WALK_SKIP_PATHS, PREFLIGHT_GIT_TIMEOUT_SECONDS, PREFLIGHT_STAT_FILE_CAP, PREFLIGHT_BINARY_LIKE_EXTENSIONS, ASYNC_MCP_SERVER_NAME, ASYNC_DISPATCH_CONTRACT_VERSION, CROSS_REPO_RESULT_MODES, ACCEPTANCE_SYNTHESIS_PROFILE, PI_ASYNC_RUNNER_SENTINEL, GLOBAL_CONFIG_PATH, PROJECT_ASYNC_TASK_ROOT, deps2, caches, PY_SPLIT_RE, CHILD_CATALOG_CONFIG_SURFACE, cacheServedCatalogs, dispatchPhaseState;
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
    CROSS_REPO_RESULT_MODES = /* @__PURE__ */ new Set(["read_only_audit", "simulated_planning", "real_rerun"]);
    ACCEPTANCE_SYNTHESIS_PROFILE = "acceptance_synthesis_v1";
    PI_ASYNC_RUNNER_SENTINEL = "run-pi-task.mjs";
    GLOBAL_CONFIG_PATH = null;
    PROJECT_ASYNC_TASK_ROOT = path16.join(ROOT, ".runtime", "cockpit", "async_tasks");
    deps2 = {
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
    dispatchPhaseState = { phase: "seed", seedIndex: 0 };
  }
});

// ops/tools/dispatch_prepare.mjs
await init_dispatch_prepare();
init_tool_common();
init_model_selection();
init_model_selection_guidance();
import process9 from "node:process";

// ops/tools/_dispatch-catalog-text.mjs
import path17 from "node:path";
var oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
var visionText = (value) => value === true ? "\u662F" : value === false ? "\u5426" : "\u672A\u77E5";
function configSourceText(source = {}) {
  const roots = [];
  if (source.project_override && source.declaration_path) {
    roots.push(path17.dirname(path17.dirname(source.declaration_path)));
  }
  if (source.global_root && !roots.includes(source.global_root)) roots.push(source.global_root);
  const override = source.project_override && source.declared_keys?.length ? `\uFF08\u9879\u76EE\u8986\u76D6 ${source.declared_keys.join("/")}\uFF09` : "";
  return `\u914D\u7F6E\u6765\u6E90\uFF1A${roots.join(" + ") || "\u672A\u77E5"}${override}`;
}
function capabilityLine(capability) {
  const phase = capability.dispatch_phase;
  const phaseText = !phase ? "\u9636\u6BB5\u672A\u58F0\u660E" : phase.kind === "workflow" ? `\u6D41\u7A0B\u5185${phase.step ? ` ${phase.step}` : ""}` : "\u76F4\u6D3E";
  return `  \u80FD\u529B ${capability.id} \xB7 ${phaseText} \xB7 \u9ED8\u8BA4 ${capability.default_pick ?? "\u65E0"}${capability.inherit_role_picks === false ? " \xB7 \u53EA\u7528\u4E13\u5C5E\u63A8\u8350\u884C" : ""}`;
}
function pickLine(pick) {
  return `  \u63A8\u8350 ${pick.id}${pick.capability ? ` [${pick.capability}]` : ""}${pick.when ? ` ${oneLine(pick.when)}` : ""} \u2192 ${pick.model}@${pick.effort} [${pick.effort_min}\u2013${pick.effort_max}]${pick.default ? " \xB7 \u9ED8\u8BA4" : ""}`;
}
function renderCatalogText(catalog) {
  const lines = [configSourceText(catalog.config_source)];
  if (catalog.config_fingerprint) lines.push(`\u914D\u7F6E\u6307\u7EB9\uFF1A${catalog.config_fingerprint}`);
  if (catalog.warnings.length) {
    lines.push("\u8B66\u544A");
    for (const item of catalog.warnings) lines.push(`  ${item.code} ${item.file} ${item.field}: ${oneLine(item.message)}`);
  }
  lines.push(catalog.model_scope === "all" ? "\u6A21\u578B\uFF08\u5B8C\u6574 Pi \u76EE\u5F55\u53CA\u914D\u7F6E\u5F15\u7528\uFF09" : "\u6A21\u578B");
  for (const model of catalog.models) {
    lines.push(`  ${model.model}${model.tag ? ` ${model.tag}` : ""} \xB7 \u89C6\u89C9 ${visionText(model.supports_vision)} \xB7 \u6863\u4F4D ${model.efforts.join("/")}${model.in_pi === false ? " \xB7 \u4E0D\u5728 Pi \u6A21\u578B\u6E05\u5355" : ""}`);
  }
  lines.push("\u89D2\u8272");
  for (const role of catalog.roles) {
    lines.push(`${role.role}\uFF1A${oneLine(role.description)}`);
    for (const item of role.capabilities) lines.push(capabilityLine(item));
    for (const pick of role.picks) lines.push(pickLine(pick));
  }
  return lines;
}

// ops/tools/dispatch_prepare.mjs
var PROGRAM = "dispatch_prepare.mjs";
var VALUE_FLAGS = {
  "--seed": { dest: "seed", default: null },
  "--seed-template": { dest: "seed_template", default: null },
  "--card-check": { dest: "card_check", default: null },
  "--route-id": { dest: "route_id", default: "" },
  "--sample-route": { dest: "sample_route", default: null },
  "--delivery": { dest: "delivery", default: "auto", choices: ["auto", "async-subagent"] },
  "--action": { dest: "action", default: "", choices: ["preview", "prepare", "submit"] },
  "--batch-id": { dest: "batch_id", default: "" },
  "--origin-id": { dest: "origin_id", default: "" },
  "--async-pick": { dest: "async_pick", default: "" },
  "--async-model": { dest: "async_model", default: "" },
  "--async-authorization": { dest: "async_authorization", default: "" },
  "--async-effort": { dest: "async_effort", default: "" },
  "--async-context-mode": { dest: "async_context_mode", default: "project-aware", choices: ["isolated", "project-aware"] },
  "--async-runner-path": { dest: "async_runner_path", default: "" },
  // 隐藏兼容参数：接受且只接受 pi，取值不参与任何解析。待 adapter 侧同步后删。
  "--async-task-root": { dest: "async_task_root", default: "" },
  "--async-target-cwd": { dest: "async_target_cwd", default: "" },
  "--async-execution-profile": { dest: "async_execution_profile", default: "", choices: ["standard", "simulation"] },
  "--async-stall-silence-ms": { dest: "async_stall_silence_ms", default: null, type: "int" },
  "--format": { dest: "format", default: "text", choices: ["text", "json"] },
  "--model-scope": { dest: "model_scope", default: "recommended", choices: ["recommended", "all"] }
};
var FLAG_TRUE = {
  "--seed-stdin": "seed_stdin",
  "--list": "list",
  "--allow-sample-pending": "allow_sample_pending",
  "--self-test": "self_test"
};
var USAGE = `usage: ${PROGRAM} [-h] [--seed SEED] [--seed-stdin] [--seed-template SEED_TEMPLATE]
                          [--card-check CARD_CHECK] [--list] [--route-id ROUTE_ID]
                          [--sample-route SAMPLE_ROUTE] [--delivery {auto,async-subagent}]
                          [--action {preview,prepare,submit}] [--batch-id BATCH_ID]
                          [--origin-id ORIGIN_ID] [--allow-sample-pending]
                          [--async-pick ASYNC_PICK] [--async-model ASYNC_MODEL]
                          [--async-effort ASYNC_EFFORT]
                          [--async-authorization ASYNC_AUTHORIZATION]
                          [--async-context-mode {isolated,project-aware}]
                          [--async-runner-path ASYNC_RUNNER_PATH]
                          [--async-task-root ASYNC_TASK_ROOT]
                          [--async-target-cwd ASYNC_TARGET_CWD]
                          [--async-execution-profile {standard,simulation}]
                          [--async-stall-silence-ms ASYNC_STALL_SILENCE_MS]
                          [--format {text,json}] [--model-scope {recommended,all}] [--self-test]`;
function argparseError(message) {
  process9.stderr.write(`${USAGE}
${PROGRAM}: error: ${message}
`);
  process9.exit(2);
}
function parseArgs(argv) {
  const args = { seed_stdin: false, list: false, allow_sample_pending: false, self_test: false };
  for (const spec of Object.values(VALUE_FLAGS)) args[spec.dest] = spec.default;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "-h" || token === "--help") {
      process9.stdout.write(`${USAGE}

\u4ECE package_seed \u6784\u5EFA\u5B50\u4EE3\u7406\u4EFB\u52A1\u5305\u5E76\u751F\u6210\u6D3E\u53D1\u7ED3\u679C\u3002
`);
      process9.exit(0);
    }
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq > 0 ? token.slice(eq + 1) : null;
    if (Object.hasOwn(FLAG_TRUE, name)) {
      if (inlineValue !== null) argparseError(`argument ${name}: ignored explicit argument '${inlineValue}'`);
      args[FLAG_TRUE[name]] = true;
      continue;
    }
    const spec = VALUE_FLAGS[name];
    if (!spec) argparseError(`unrecognized arguments: ${token}`);
    let value = inlineValue;
    if (value === null) {
      index += 1;
      if (index >= argv.length) argparseError(`argument ${name}: expected one argument`);
      value = String(argv[index]);
    }
    if (spec.choices && !spec.choices.includes(value)) {
      argparseError(`argument ${name}: invalid choice: '${value}' (choose from ${spec.choices.map((item) => `'${item}'`).join(", ")})`);
    }
    if (spec.type === "int") {
      if (!/^[+-]?\d+$/.test(value.trim())) argparseError(`argument ${name}: invalid int value: '${value}'`);
      args[spec.dest] = Number.parseInt(value.trim(), 10);
      continue;
    }
    args[spec.dest] = value;
  }
  return args;
}
async function main() {
  const args = parseArgs(process9.argv.slice(2));
  if (args.model_scope !== "recommended" && !args.list) throw new ToolError("--model-scope \u4EC5\u7528\u4E8E --list");
  if (args.self_test) {
    const data2 = await selfTest2();
    const text4 = data2.status === "ok" ? "dispatch_prepare self-test passed" : "dispatch_prepare self-test failed\n\u63D0\u793A\uFF1A\u81EA\u6D4B\u90E8\u5206\u65AD\u8A00\u8BFB\u53D6\u6D3B\u914D\u7F6E\uFF08route \u5361 / agents toml\uFF09\uFF0C\u5931\u8D25\u65F6\u5148\u68C0\u67E5\u914D\u7F6E\u662F\u5426\u521A\u53D8\u66F4\u3002";
    return emit(data2, args.format, text4);
  }
  if (args.seed_template) {
    process9.stdout.write(`${renderTemplate(args.seed_template)}
`);
    return 0;
  }
  if (args.card_check) {
    const targets = args.card_check === "all" ? routesWithCards() : [args.card_check];
    if (!targets.length) throw new ToolError("no route cards found");
    const results = {};
    for (const rid of targets) {
      try {
        checkRouteCard(rid);
        results[rid] = "pass";
      } catch (error) {
        if (!isPyCaughtError(error, /* @__PURE__ */ new Set(["ToolError", "KeyError", "ValueError"]))) throw error;
        results[rid] = `fail: ${error.message}`;
      }
    }
    const failed = Object.entries(results).filter(([, value]) => value !== "pass");
    const data2 = { status: failed.length ? "failed" : "ok", results };
    const text4 = Object.entries(results).map(([rid, value]) => `${rid}: ${value}`).join("\n");
    return emit(data2, args.format, text4);
  }
  if (args.list) {
    const config = loadSelectionConfig(modelConfigSources());
    const [role, capability = ""] = args.route_id ? args.route_id.split("__") : [];
    if (capability && !config.routes.some((route) => route.route_id === args.route_id)) {
      throw new ToolError(`\u672A\u77E5\u8DEF\u7531\uFF1A${args.route_id}\uFF1B\u7701\u7565 route_id \u67E5\u770B\u5168\u90E8\u8DEF\u7531`);
    }
    const probed = probePiChildModelCatalog(ROOT);
    if (args.model_scope === "all" && probed.status !== "ok") {
      throw new ToolError(`\u5B8C\u6574\u6A21\u578B\u76EE\u5F55\u8BFB\u53D6\u5931\u8D25\uFF1A${probed.error || probed.status}`);
    }
    const catalog = projectCatalog(config, {
      piModels: probed.status === "ok" ? probed.models : null,
      ...role ? { role, capability } : {}
    });
    const used = new Set(catalog.roles.flatMap((item) => item.picks.map((pick) => pick.model)));
    const projected = {
      ...catalog,
      model_scope: args.model_scope,
      model_catalog_source: probed.source,
      models: args.model_scope === "all" ? catalog.models : catalog.models.filter((item) => used.has(item.model) || config.notes.has(item.model))
    };
    if (args.format === "json") process9.stdout.write(`${JSON.stringify(projected)}
`);
    else process9.stdout.write(`${renderCatalogText(projected).join("\n")}
`);
    return 0;
  }
  const effectiveAction = normalizeDispatchAction(args.action);
  if (args.sample_route && !args.allow_sample_pending && effectiveAction === "submit") {
    const sampleWouldSubmitAsync = args.delivery === "async-subagent" || args.delivery === "auto" && asyncSubagentReadiness().status === "available";
    if (sampleWouldSubmitAsync) {
      throw new ToolError(
        "--sample-route with async delivery would submit a background task; use --action preview to preview the sample or --allow-sample-pending for an intentional dispatch sample"
      );
    }
  }
  const seeds = loadSeeds(args);
  if (seeds.length === 1) {
    const [singleSliceId, singleTitle] = sliceMetadata(seeds[0], 0);
    const data2 = prepareDispatch(seeds[0], args.delivery, {
      action: effectiveAction,
      asyncPick: args.async_pick,
      asyncAuthorization: args.async_authorization,
      asyncModel: args.async_model,
      asyncEffort: args.async_effort,
      asyncContextMode: args.async_context_mode,
      asyncRunnerPath: args.async_runner_path,
      asyncTaskRoot: args.async_task_root,
      asyncTargetCwd: args.async_target_cwd,
      asyncExecutionProfile: args.async_execution_profile,
      asyncStallSilenceMs: args.async_stall_silence_ms,
      asyncBatchId: args.batch_id,
      asyncSliceId: args.batch_id ? singleSliceId : "",
      asyncDisplayTitle: singleTitle,
      originId: args.origin_id || null
    });
    await attachAgentPanelLaunch(data2, { dryRun: effectiveAction === "preview" });
    const payload = data2.spawn_payload || `PREPARED_DISPATCH: ${data2.descriptor_file}`;
    let text4 = `status=${data2.status} action=${Object.hasOwn(data2, "action") ? data2.action : effectiveAction} delivery_mode=${data2.delivery_mode} agent_type=${data2.agent_type} package_id=${data2.package_id}
${payload}`;
    const preflightWarning = data2.scope_preflight.scope_preflight_warning;
    if (preflightWarning) text4 += `

\u63D0\u793A\uFF1A${preflightWarning}`;
    const selected = data2.async_preview?.selection || data2.async_model_selection?.selection || data2.selection;
    if (selected) {
      data2.selection_summary = selectionSummary(selected);
      text4 += `
\u9009\u578B\uFF1A${data2.selection_summary}`;
    }
    text4 += agentPanelLaunchText(data2);
    return emit(data2, args.format, text4);
  }
  const data = prepareBatchDispatch(seeds, args.delivery, {
    batchId: args.batch_id,
    action: effectiveAction,
    asyncPick: args.async_pick,
    asyncAuthorization: args.async_authorization,
    asyncModel: args.async_model,
    asyncEffort: args.async_effort,
    asyncContextMode: args.async_context_mode,
    asyncRunnerPath: args.async_runner_path,
    asyncTaskRoot: args.async_task_root,
    asyncTargetCwd: args.async_target_cwd,
    asyncExecutionProfile: args.async_execution_profile,
    asyncStallSilenceMs: args.async_stall_silence_ms,
    originId: args.origin_id || null
  });
  await attachAgentPanelLaunch(data, { dryRun: effectiveAction === "preview" });
  const dispatches = data.dispatches;
  for (const item of dispatches) {
    const selected = item.async_preview?.selection || item.async_model_selection?.selection || item.selection;
    if (selected) item.selection_summary = selectionSummary(selected);
  }
  const failedIndexes = data.failed_seed_indexes;
  const notSubmittedIndexes = data.not_submitted_seed_indexes;
  let text3 = dispatches.map((item, idx) => `[${idx + 1}/${dispatches.length}] status=${item.status} ` + (item.status === "ok" ? `delivery_mode=${item.delivery_mode} agent_type=${item.agent_type} package_id=${item.package_id} \u9009\u578B=${selectionSummary(item.async_preview?.selection || item.async_model_selection?.selection || item.selection)}
${item.spawn_payload || `PREPARED_DISPATCH: ${item.descriptor_file || ""}`}` : `seed_index=${item.seed_index} error=${item.error}`)).join("\n\n");
  if (failedIndexes.length) {
    text3 += `

\u6279\u91CF\u6D3E\u53D1\u90E8\u5206\u5931\u8D25\uFF1Abatch_id=${data.batch_id}\uFF0C\u5931\u8D25 seed \u5E8F\u53F7 ${pyListRepr(failedIndexes)}\uFF1B\u672A\u63D0\u4EA4 seed \u5E8F\u53F7 ${notSubmittedIndexes.length ? pyListRepr(notSubmittedIndexes) : "(\u65E0)"}\uFF1B\u5DF2\u63D0\u4EA4 task_id\uFF1A${data.committed_task_ids.length ? pyListRepr(data.committed_task_ids) : "(\u65E0)"}\u3002\u5931\u8D25\u9879\u548C\u672A\u63D0\u4EA4\u9879\u90FD\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\uFF0C\u4FEE\u6B63\u5BF9\u5E94 seed \u540E\u5355\u72EC\u91CD\u53D1\u3002`;
  } else if (effectiveAction === "preview") {
    text3 += `

\u4EE5\u4E0A\u4E3A batch_id=${data.batch_id} \u7684 preview \u9884\u89C8\uFF1A\u672A\u63D0\u4EA4 async \u4EFB\u52A1\u3002`;
  } else if (effectiveAction === "prepare") {
    text3 += `

\u6279\u91CF prepare \u5B8C\u6210\uFF1Abatch_id=${data.batch_id}\uFF0C\u5DF2\u5199\u5165 prepared workspace\uFF1B\u672A\u63D0\u4EA4 async \u4EFB\u52A1\u3002`;
  } else {
    text3 += `

\u6279\u91CF\u6D3E\u53D1\u5B8C\u6210\uFF1Abatch_id=${data.batch_id}\uFF0Ctask_id=${pyListRepr(data.committed_task_ids)}\u3002`;
  }
  const preflightWarnings = dispatches.map((item, idx) => [idx, (item.scope_preflight || {}).scope_preflight_warning]).filter(([, warning]) => warning).map(([idx, warning]) => `[${idx + 1}/${dispatches.length}] ${warning}`);
  if (preflightWarnings.length) text3 += `

\u63D0\u793A\uFF1A
${preflightWarnings.join("\n")}`;
  text3 += agentPanelLaunchText(data);
  return emit(data, args.format, text3);
}
function pyListRepr(values) {
  return `[${values.map((item) => typeof item === "string" ? `'${item}'` : String(item)).join(", ")}]`;
}
function emitCliError(error) {
  const argv = process9.argv;
  const jsonRequested = argv.some((arg, index) => arg === "--format=json" || arg === "--format" && index + 1 < argv.length && argv[index + 1] === "json");
  if (jsonRequested) {
    process9.stdout.write(`${JSON.stringify({
      status: "error",
      stage: currentDispatchPhase(),
      message: String(error?.message ?? error)
    })}
`);
  } else {
    process9.stderr.write(`error: ${String(error?.message ?? error)}
`);
  }
}
try {
  process9.exitCode = await main();
} catch (error) {
  if (!isPyCaughtError(error, /* @__PURE__ */ new Set(["ToolError", "KeyError", "OSError", "ValueError"]))) throw error;
  emitCliError(error);
  process9.exitCode = 1;
}
