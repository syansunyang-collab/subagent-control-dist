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
function isAbsoluteLikePython(value) {
  const text2 = String(value ?? "");
  if (process3.platform !== "win32") return text2.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text2) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text2);
}
function pathlibJoin(base, other) {
  const text2 = String(other ?? "");
  if (isAbsoluteLikePython(text2)) return text2;
  if (process3.platform === "win32" && /^[\\/]/.test(text2)) {
    const drive = path2.parse(path2.resolve(String(base))).root.replace(/[\\/]+$/, "");
    return `${drive}${text2}`;
  }
  return path2.join(String(base), text2);
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
    process3.stdout.write(`${canonicalJson(data)}
`);
  } else {
    const trimmed = String(text2 ?? "").replace(/\s+$/, "");
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
  return process4.platform === "win32" ? text2.replace(/\//g, "\\").toLowerCase() : text2;
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
function pySpawnSync(command, args, options) {
  const cmd = String(command);
  if (process4.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    const quote = (value) => {
      const text2 = String(value);
      return /[\s"^&|<>()%!]/.test(text2) ? `"${text2.replace(/"/g, '\\"')}"` : text2;
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

// ops/tools/dispatch-core/subagent_preload.mjs
import { opendirSync, statSync as statSync3 } from "node:fs";
import path4 from "node:path";
function jsonErrorLine2(text2, error) {
  const message = String(error?.message ?? "");
  const line = /\(line (\d+) column \d+\)/.exec(message);
  if (line) return Number(line[1]);
  const position = /position (\d+)/.exec(message);
  if (position) return text2.slice(0, Number(position[1])).split("\n").length;
  return 1;
}
function orNull(value) {
  return value === void 0 ? null : value;
}
function isFile2(target) {
  try {
    return statSync3(target).isFile();
  } catch {
    return false;
  }
}
function repoPath(value) {
  const raw = pyStrip(pyStr(pyOr(value, "")));
  if (!raw) throw new ToolError("empty required_files path");
  const projectReal = resolveLikePython(ROOT);
  const lexical = path4.resolve(ROOT, raw);
  const lexicalRelative = path4.relative(projectReal, lexical);
  if (lexicalRelative.startsWith("..") || path4.isAbsolute(lexicalRelative)) {
    throw new ToolError(`required file escapes repository: ${raw}`);
  }
  const resolved = resolveLikePython(lexical);
  const relative = path4.relative(projectReal, resolved);
  if (relative.startsWith("..") || path4.isAbsolute(relative)) {
    if (!isSameOrInside(resolved, RUNTIME_ROOT)) {
      throw new ToolError(`required file escapes repository: ${raw}`);
    }
  }
  if (!isFile2(resolved)) throw new ToolError(`required file not found: ${raw}`);
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
    const target = resolveLikePython(path4.resolve(RUNTIME_ROOT, item));
    if (!isSameOrInside(target, RUNTIME_ROOT)) throw new ToolError(`required prompt escapes runtime: ${item}`);
    files.push({ path: item, content: pyReadText(target) });
  }
  return files;
}
function reviewEvidenceSupport(pkg) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const reference = isRecord(extensions.review_evidence) ? extensions.review_evidence : {};
  const rawPath = reference.path;
  if (typeof rawPath !== "string" || !pyStrip(rawPath)) return null;
  const target = repoPath(rawPath);
  try {
    const info = statSync3(target);
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
  if (isFile2(target)) {
    yield target;
    return;
  }
  let directory;
  try {
    directory = opendirSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    missingPaths.push(target);
    return;
  }
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      const child = path4.join(target, entry.name);
      if (entry.isDirectory()) yield* scopeFiles(child, missingPaths);
      else if (isFile2(child)) yield child;
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
      const target = path4.resolve(base, pyStr(item));
      const missingPaths = [];
      for (const file of scopeFiles(target, missingPaths)) {
        const shown = path4.relative(base, file).replaceAll("\\", "/");
        const bytes = statSync3(file).size;
        if (bytes > remaining) {
          omittedScopeFiles.push({ path: shown, bytes });
          continue;
        }
        remaining -= bytes;
        supportFiles.push({ path: shown, heading: `\u5377\u5B97\uFF1A${shown}`, content: pyReadText(file) });
      }
      for (const missing of missingPaths) {
        omittedScopeFiles.push({ path: path4.relative(base, missing).replaceAll("\\", "/"), missing: true });
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
  return renderDirectTaskMaterial(loadPackage(packagePath), path4.resolve(packagePath));
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

// ops/tools/dispatch-core/agent_panel_launcher.mjs
import { createHash as createHash2 } from "node:crypto";
import { closeSync as closeSync2, mkdirSync as mkdirSync2, openSync as openSync2, readdirSync, readFileSync as readFileSync4, renameSync as renameSync2, rmSync, statSync as statSync4, writeFileSync, writeSync as writeSync2 } from "node:fs";
import net from "node:net";
import path5 from "node:path";
import { homedir } from "node:os";
import process5 from "node:process";
import { spawn as spawnChild, spawnSync as spawnSync2 } from "node:child_process";
function releasedPanelAssetRoot() {
  try {
    return JSON.parse(readFileSync4(path5.join(PANEL_STATE_ROOT, "runtime-root.json"), "utf8")).root;
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
function isFile3(target) {
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
  const deps2 = {
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
  deps2.isOurPanel ??= (payload, endpoint) => isOurPanel(payload, endpoint);
  deps2.allocateEndpoint ??= () => allocateEndpoint({ deps: deps2 });
  deps2.rememberProject ??= () => rememberProject({ deps: deps2 });
  deps2.validManifest ??= () => validManifest({ deps: deps2 });
  deps2.runningShell ??= () => runningShell({ deps: deps2 });
  deps2.buildRunning ??= () => buildRunning({ deps: deps2 });
  deps2.acquireBuildLock ??= () => acquireBuildLock({ deps: deps2 });
  deps2.startShell ??= (executable, endpoint) => startShell(executable, endpoint, { deps: deps2 });
  deps2.startBackgroundBuild ??= () => startBackgroundBuild({ deps: deps2 });
  deps2.killProcessTree ??= killProcessTree;
  deps2.sleep ??= (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return deps2;
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
    const value = JSON.parse(readFileSync4(file, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
function writeJson(file, value) {
  mkdirSync2(path5.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  renameSync2(temp, file);
  return null;
}
function normalizeIdentityPath(value) {
  const text2 = resolveLikePython(String(value)).replaceAll("\\", "/");
  return process5.platform === "win32" ? text2.toLowerCase() : text2;
}
function deriveEndpoint(panelRoot = PANEL_ROOT, controlRoot = MONITOR_ROOT) {
  const panelDigest = createHash2("sha256").update(normalizeIdentityPath(panelRoot), "utf8").digest();
  const port = PORT_BASE + panelDigest.readUInt16BE(0) % PORT_SPAN;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    panel_root: normalizeIdentityPath(panelRoot),
    control_root: normalizeIdentityPath(controlRoot)
  };
}
function rememberProject({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
  const root = resolveLikePython(resolved.paths.controlRoot);
  const key = createHash2("sha256").update(normalizeIdentityPath(root)).digest("hex");
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
async function allocateEndpoint({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
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
    const text2 = pid.trim();
    if (!/^[+-]?\d+$/.test(text2)) return false;
    value = Number(text2);
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
function runningShell({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
  const state = resolved.readJson(resolved.paths.shellStatePath);
  return state?.running === true && resolved.isProcessAlive(state.pid) ? state : {};
}
function buildRunning({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
  const state = resolved.readJson(resolved.paths.buildStatePath);
  return state?.status === "running" && resolved.isProcessAlive(state.pid);
}
function runtimeBuildId({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
  return resolved.readJson(path5.join(resolved.paths.assetRoot, "ops", "dist", "subagent_service.manifest.json")).build_id ?? null;
}
function validManifest({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
  const manifest = resolved.readJson(resolved.paths.manifestPath);
  const executable = textOrEmpty(manifest?.executable);
  return executable && isFile3(executable) && manifest.runtime_build_id === runtimeBuildId({ deps: resolved }) ? manifest : {};
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
function startShell(executable, endpoint, { deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
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
function startBackgroundBuild({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
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
function killProcessTree(pid) {
  if (process5.platform === "win32") spawnSync2("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
  else process5.kill(pid, "SIGTERM");
}
async function stopStalePanel(resolved) {
  const shell = resolved.runningShell();
  if (!filled(shell) || !shell.url) return null;
  const port = Number(new URL(shell.url).port);
  const health = await resolved.probeHealth(port);
  const previous = health?.runtime_build_id;
  const current = runtimeBuildId({ deps: resolved });
  if (!previous || !current || previous === current || health.shell_pid !== shell.pid) return null;
  resolved.killProcessTree(shell.pid);
  const deadline = Date.now() + PANEL_STOP_TIMEOUT_MS;
  while (!await resolved.portIsFree(port)) {
    if (Date.now() > deadline) throw pyError("RuntimeError", `\u65E7\u9762\u677F\uFF08\u6784\u5EFA ${previous}\uFF09\u672A\u9000\u51FA\uFF0C\u672A\u542F\u52A8\u5F53\u524D\u6784\u5EFA`);
    await resolved.sleep(100);
  }
  return { previous_build_id: previous, runtime_build_id: current };
}
async function ensureAgentPanel({ deps: deps2, replaceStaleBuild = false } = {}) {
  const resolved = resolveDeps(deps2);
  try {
    if (!isFile3(resolved.paths.projectFile)) {
      throw pyError("RuntimeError", `Agent Panel shell project is missing: ${resolved.paths.projectFile}`);
    }
    resolved.rememberProject();
    const replaced = replaceStaleBuild ? await stopStalePanel(resolved) : null;
    const endpoint = await resolved.allocateEndpoint();
    const manifest = resolved.validManifest();
    const health = await resolved.probeHealth(Number(pyGetItem(endpoint, "port")));
    if (resolved.isOurPanel(health, endpoint)) return { status: "already_running", ...endpoint, monitor_root: health.control_repo_path };
    const shell = resolved.runningShell();
    if (filled(shell)) return { status: "starting", pid: shell.pid, ...endpoint };
    let launched;
    if (filled(manifest)) launched = resolved.startShell(String(pyGetItem(manifest, "executable")), endpoint);
    else if (resolved.buildRunning()) launched = { status: "build_started", build_in_progress: true, ...endpoint };
    else launched = { status: "build_started", pid: resolved.startBackgroundBuild(), log_path: String(resolved.paths.buildLogPath), ...endpoint };
    return replaced ? { ...launched, ...replaced } : launched;
  } catch (error) {
    return { status: "failed", error: errorText(error), log_path: String(resolved.paths.buildLogPath) };
  }
}
function acquireBuildLock({ deps: deps2 } = {}) {
  const resolved = resolveDeps(deps2);
  mkdirSync2(resolved.paths.runtimeRoot, { recursive: true });
  try {
    return openSync2(resolved.paths.buildLockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    const stale = Date.now() / 1e3 - statSync4(resolved.paths.buildLockPath).mtimeMs / 1e3;
    if (stale > STILL_ACTIVE_LOCK_STALE_SECONDS && !resolved.buildRunning()) {
      rmSync(resolved.paths.buildLockPath, { force: true });
      return openSync2(resolved.paths.buildLockPath, "wx");
    }
  } catch {
  }
  return null;
}
var MONITOR_ROOT, PANEL_STATE_ROOT, PANEL_ASSET_ROOT, PANEL_ROOT, SHELL_ROOT, PROJECT_FILE, RUNTIME_ROOT2, ENDPOINT_PATH, MANIFEST_PATH, BUILD_STATE_PATH, BUILD_LOG_PATH, BUILD_LOCK_PATH, SHELL_STATE_PATH, PORT_BASE, PORT_SPAN, DEFAULT_PATHS, STILL_ACTIVE_LOCK_STALE_SECONDS, PANEL_STOP_TIMEOUT_MS;
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
    PANEL_STOP_TIMEOUT_MS = 5e3;
  }
});

// ops/tools/dispatch-core/prepared_dispatch.mjs
import {
  closeSync as closeSync3,
  fstatSync as fstatSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync3,
  openSync as openSync3,
  readFileSync as readFileSync5,
  readdirSync as readdirSync2,
  rmSync as rmSync2,
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
    const text2 = `[${value.map((item) => _canonicalJsonText(item, seen)).join(",")}]`;
    seen.delete(value);
    return text2;
  }
  if (_isPlainObject(value)) {
    if (seen.has(value)) throw new PreparedDispatchError("value is not canonical JSON: Circular reference detected");
    seen.add(value);
    const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const text2 = `{${keys.map((key) => `${JSON.stringify(key)}:${_canonicalJsonText(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return text2;
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
      mkdirSync3(preparation, { mode: 448 });
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
  const text2 = (value) => value ? String(value) : "";
  return {
    contract_version: DISPATCH_CONTRACT_VERSION,
    producer_root: String(producerRoot),
    origin_thread_id: String(originId),
    target_cwd: String(targetCwd),
    task_file: "",
    task_root: String(taskRoot),
    runner_path: _runtimeValue(options, "runner_path") || null,
    runtime_role: text2(_runtimeValue(options, "runtime_role", "")),
    model: text2(_runtimeValue(options, "model", modelSelection.primary_model ?? "")) || null,
    effort: text2(_runtimeValue(options, "effort", modelSelection.primary_effort ?? "")) || null,
    ...isRecord(modelSelection.selection) ? { selection: modelSelection.selection } : {},
    context_mode: text2(_runtimeValue(options, "context_mode", "project-aware")) || "project-aware",
    execution_profile: text2(_runtimeValue(options, "execution_profile", "standard")) || "standard",
    result_mode: text2(_runtimeValue(options, "result_mode", "")) || null,
    simulation: (_runtimeValue(options, "simulation_profile") || _runtimeValue(options, "simulation")) ?? null,
    budget: _runtimeValue(options, "budget", {}),
    batch_id: _runtimeValue(options, "batch_id") || null,
    slice_id: _runtimeValue(options, "slice_id") || null,
    display_title: text2(_runtimeValue(options, "display_title", ""))
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
  const parts = (text3) => String(text3).replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  const text2 = String(value);
  if (!path6.isAbsolute(text2)) return parts(text2).join("/") || ".";
  const target = parts(text2);
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
    return readFileSync5(fd);
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
      rmSync2(marker, { recursive: true });
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
    rmSync2(root, { recursive: true });
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
import path7 from "node:path";
var ROUTE_DIR, SEED_BODY_REQUIRED;
var init_task_package_profiles = __esm({
  "ops/tools/dispatch-core/task_package_profiles.mjs"() {
    init_tool_common();
    init_py();
    ROUTE_DIR = path7.join(RUNTIME_ROOT, "ops", "protocols", "task-package-routes");
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
  }
});

// ops/tools/dispatch-core/task_package_build.mjs
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
import { opendirSync as opendirSync2, readdirSync as readdirSync3, statSync as statSync6 } from "node:fs";
import path8 from "node:path";
import process6 from "node:process";
function statOrNull(value) {
  try {
    return statSync6(value);
  } catch {
    return null;
  }
}
function pathExists(value) {
  return statOrNull(value) !== null;
}
function pathIsDir(value) {
  return Boolean(statOrNull(value)?.isDirectory());
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
function tail(text2, limit = 600) {
  const value = String(text2 || "");
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
  const text2 = String(surface);
  const descriptor = text2.includes(":") ? text2.slice(text2.indexOf(":") + 1) : text2;
  const rangeMatch = SURFACE_RANGE_RE.exec(descriptor);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    let end = Number(rangeMatch[2]);
    if (start >= 1 && start <= end) {
      end = Math.min(end, lines.length, start + SURFACE_RANGE_MAX_LINES - 1);
      if (start <= lines.length) {
        const picked = [];
        for (let index = start - 1; index < end; index += 1) picked.push(`${index + 1}: ${lines[index]}`);
        return { surface: text2, lines: picked };
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
  return { surface: text2, lines: selected.map((index) => `${index + 1}: ${lines[index]}`) };
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
      entry.entries = readdirSync3(target).length;
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
        bytes2 = statSync6(abs).size;
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
    bytes = statSync6(abs).size;
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
      handle = opendirSync2(current);
    } catch {
      return;
    }
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const full = path8.join(current, entry.name);
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
function atomicWriteText(target, text2) {
  atomicWriteBytes2(target, Buffer.from(String(text2), "utf8"));
  return null;
}
function executeChecks(root, checks, logRoot) {
  const results = [];
  ensureDirectory(logRoot);
  for (const raw of checks) {
    const [checkId, argv, cwd, timeout, expected] = validateCheck(raw, root);
    const result = run(argv, cwd, timeout);
    const safe = checkId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
    const logPath = path8.join(String(logRoot), `${safe}.log`);
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
  const parsed = path8.parse(target);
  const stripped = parsed.ext ? path8.join(parsed.dir, parsed.name) : target;
  return stripped !== target ? stripped : path8.join(parsed.dir, `${parsed.base}.logs`);
}
function evidenceOutputPath(pkg, options = {}) {
  const { outputRoot = null, outputPath = null } = options;
  const packageId2 = String(pkg?.package_id || "package");
  if (outputPath !== null && outputPath !== void 0) {
    return lexicalAbsolute(outputPath);
  }
  if (outputRoot !== null && outputRoot !== void 0) {
    const root2 = lexicalAbsolute(outputRoot);
    if (path8.extname(root2).toLowerCase() === ".json" || Boolean(statOrNull(root2)?.isFile())) return root2;
    return assertDerivedOutputContained(path8.join(root2, derivedEvidenceFilename(packageId2)), root2);
  }
  const root = lexicalAbsolute(path8.join(ROOT, "tmp", "review_evidence"));
  return assertDerivedOutputContained(path8.join(root, derivedEvidenceFilename(packageId2)), root);
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

// ops/tools/dispatch-core/model_catalog_cache.mjs
import { mkdirSync as mkdirSync4, readFileSync as readFileSync6, renameSync as renameSync3, rmSync as rmSync3, statSync as statSync7, writeFileSync as writeFileSync2 } from "node:fs";
import { createHash as createHash3, randomBytes } from "node:crypto";
import path9 from "node:path";
function canonicalJson2(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}
function catalogCacheKey(identity) {
  return createHash3("sha256").update(canonicalJson2(identity), "utf8").digest("hex");
}
function statOrNull2(target) {
  try {
    return statSync7(target);
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
    const stat = statOrNull2(target);
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
  let text2;
  try {
    text2 = readFileSync6(cacheFile, "utf8");
  } catch {
    return { entries: [] };
  }
  let payload;
  try {
    payload = JSON.parse(text2);
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
    mkdirSync4(path9.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync2(tmp, `${JSON.stringify({ schema: CATALOG_CACHE_SCHEMA, entries }, null, 2)}
`, "utf8");
      renameSync3(tmp, cacheFile);
    } finally {
      rmSync3(tmp, { force: true });
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

// ops/tools/pi_model_extension_profile.mjs
import { existsSync as existsSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path10 from "node:path";
function resolvePiAgentDir(env = process.env) {
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  return path10.resolve(configured || path10.join(homedir2(), ".pi", "agent"));
}
function resolvePiChildModelExtensions(options = {}) {
  const env = options.env || process.env;
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync3;
  const agentDir = path10.resolve(options.agentDir || resolvePiAgentDir(env));
  return RELATIVE_EXTENSION_PATHS.map((relativePath) => path10.join(agentDir, ...relativePath.split("/"))).filter((candidate) => exists(candidate));
}
function isPiModelExtensionProfileCli(argv1 = process.argv[1]) {
  return path10.basename(String(argv1 || "")).toLowerCase() === "pi_model_extension_profile.mjs";
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

// ops/tools/dispatch-core/dispatch-prepare/deps.mjs
var deps;
var init_deps = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/deps.mjs"() {
    deps = {};
  }
});

// ops/tools/dispatch-core/dispatch-prepare/py-utils.mjs
import { statSync as statSync8 } from "node:fs";
import path11 from "node:path";
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
    return statSync8(target);
  } catch {
    return null;
  }
}
function isFile4(target) {
  return Boolean(statOrNull3(target)?.isFile());
}
function shutilWhich(name) {
  const candidate = String(name ?? "");
  if (!candidate) return null;
  const isWindows = process7.platform === "win32";
  const exts = isWindows ? String(process7.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const hasExt = isWindows && exts.some((ext) => candidate.toLowerCase().endsWith(ext.toLowerCase()));
  const names = isWindows && !hasExt ? exts.map((ext) => candidate + ext) : [candidate];
  if (candidate.includes("/") || candidate.includes("\\")) {
    for (const item of names) if (isFile4(item)) return item;
    return null;
  }
  const dirs = String(process7.env.PATH || "").split(path11.delimiter).filter(Boolean);
  if (isWindows) dirs.unshift(process7.cwd());
  for (const dir of dirs) {
    for (const item of names) {
      const full = path11.join(dir, item);
      if (isFile4(full)) return full;
    }
  }
  return null;
}
var PY_SPLIT_RE;
var init_py_utils = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/py-utils.mjs"() {
    init_tool_common();
    init_py();
    PY_SPLIT_RE = new RegExp(`[${PY_SPACE_CLASS}]+`);
  }
});

// ops/tools/dispatch-core/dispatch-prepare/state.mjs
var caches;
var init_state = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/state.mjs"() {
    caches = {
      asyncSubagentServer: /* @__PURE__ */ new Map(),
      asyncSubagentEndpoint: /* @__PURE__ */ new Map(),
      asyncSubagentReadiness: /* @__PURE__ */ new Map(),
      piChildModelExtensionProfile: /* @__PURE__ */ new Map(),
      childModelCatalog: /* @__PURE__ */ new Map()
    };
  }
});

// ops/tools/dispatch-core/dispatch-prepare/catalog.mjs
import path12 from "node:path";
import process8 from "node:process";
function piChildCatalogCommandImpl() {
  const configured = pyStrip(String(process8.env.PI_CONTROL_PI || ""));
  if (configured) {
    const suffix = path12.extname(configured).toLowerCase();
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
  return deps.piChildCatalogCommand();
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
  if (!extensions.every((item) => typeof item === "string" && isAbsoluteLikePython(item) && isFile4(item))) {
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
    ...CHILD_CATALOG_CONFIG_SURFACE.map((name) => path12.join(agentDir, ...String(name).split("/")))
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
  const cacheDir = override ? resolveLikePython(override) : path12.join(ROOT, ".runtime", "cockpit", "cache");
  return path12.join(cacheDir, CATALOG_CACHE_FILE_NAME);
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
var CHILD_CATALOG_CONFIG_SURFACE, cacheServedCatalogs;
var init_catalog = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/catalog.mjs"() {
    init_tool_common();
    init_py();
    init_model_catalog_cache();
    init_pi_model_extension_profile();
    init_deps();
    init_py_utils();
    init_state();
    CHILD_CATALOG_CONFIG_SURFACE = Object.freeze([
      "models.json",
      "models-store.json",
      "settings.json",
      "npm/package.json"
    ]);
    cacheServedCatalogs = /* @__PURE__ */ new WeakSet();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/constants.mjs
import path13 from "node:path";
var PREFLIGHT_BYTES_THRESHOLD, PREFLIGHT_LARGE_FILE_BYTES, ASYNC_MCP_SERVER_NAME, ASYNC_DISPATCH_CONTRACT_VERSION, PROJECT_ASYNC_TASK_ROOT;
var init_constants = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/constants.mjs"() {
    init_tool_common();
    init_prepared_dispatch();
    PREFLIGHT_BYTES_THRESHOLD = 10 * 1024 * 1024;
    PREFLIGHT_LARGE_FILE_BYTES = 2 * 1024 * 1024;
    ASYNC_MCP_SERVER_NAME = "asyncSubagent";
    ASYNC_DISPATCH_CONTRACT_VERSION = DISPATCH_CONTRACT_VERSION;
    PROJECT_ASYNC_TASK_ROOT = path13.join(ROOT, ".runtime", "cockpit", "async_tasks");
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
var EFFORT_LEVELS, PICK_KEYS, NOTE_KEYS, REMOVED_ROLE_KEYS, REMOVED_NOTE_KEYS, WORKER_RESOURCE_LISTS, PROJECT_SKILL_MODES;
var init_model_selection = __esm({
  "ops/tools/dispatch-core/model_selection.mjs"() {
    init_dist();
    init_dispatch_prepare_argv();
    init_tool_common();
    EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
  }
});

// ops/tools/dispatch-core/seed_minimal.mjs
var FULL_SEED_FIELDS;
var init_seed_minimal = __esm({
  "ops/tools/dispatch-core/seed_minimal.mjs"() {
    init_tool_common();
    init_py();
    init_task_package_profiles();
    init_task_package_build();
    init_model_selection_guidance();
    init_model_selection();
    FULL_SEED_FIELDS = new Set(SEED_BODY_REQUIRED);
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

// ops/tools/dispatch-core/dispatch-prepare/seed.mjs
var init_seed = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/seed.mjs"() {
    init_tool_common();
    init_py();
    init_seed_minimal();
    init_task_package_build();
    init_task_package_lint();
    init_py_utils();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/server.mjs
import { readFileSync as readFileSync7 } from "node:fs";
import path14 from "node:path";
import process9 from "node:process";
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
  const envConfig = pyStrip(String(process9.env.COCKPIT_GLOBAL_CONFIG || ""));
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
  return { ...process9.env, ...pyTruthy(server?.env) ? server.env : {} };
}
function loadToml(target) {
  let text2;
  try {
    text2 = readFileSync7(String(target), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  let data;
  try {
    data = parse(text2);
  } catch (error) {
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  return isRecord(data) ? data : {};
}
var init_server = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/server.mjs"() {
    init_dist();
    init_tool_common();
    init_py();
    init_constants();
    init_deps();
    init_state();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/delivery.mjs
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
  if (pyTruthy(toolPath) && !isFile4(toolPath)) {
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
  if (!pyTruthy(toolPath) || !isFile4(toolPath)) {
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
var init_delivery = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/delivery.mjs"() {
    init_tool_common();
    init_py();
    init_constants();
    init_deps();
    init_py_utils();
    init_seed();
    init_server();
    init_state();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/scope.mjs
import { existsSync as existsSync4, readdirSync as readdirSync4, statSync as statSync9 } from "node:fs";
import path15 from "node:path";
function* walkDir(top, onError) {
  const stack = [String(top)];
  while (stack.length) {
    const dirpath = stack.pop();
    let entries;
    try {
      entries = readdirSync4(dirpath, { withFileTypes: true });
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
      stack.push(path15.join(dirpath, frame.dirnames[index]));
    }
  }
}
var init_scope = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/scope.mjs"() {
    init_tool_common();
    init_py();
    init_constants();
    init_deps();
    init_py_utils();
  }
});

// ops/tools/pi_worker_resources.mjs
import { spawn } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync8, statSync as statSync10, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import path16 from "node:path";
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
  const file = path16.join(dir, "package.json");
  if (!existsSync5(file)) return null;
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
      for (const text2 of ["label", "group"]) {
        if (entry[text2] !== void 0 && typeof entry[text2] !== "string") throw configError("value_invalid", configPath, `${field}.${text2}`, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
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
  const rank = (key) => key.includes("*") ? literalLength(key) : Number.POSITIVE_INFINITY;
  const best = Math.max(...hits.map(rank));
  const top = hits.filter((key) => rank(key) === best);
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
  agentDir = process.env.PI_CODING_AGENT_DIR || path16.join(homedir3(), ".pi", "agent"),
  piCli = PI_CLI
} = {}) {
  const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL(path16.join(path16.dirname(piCli), "index.js")).href);
  const settingsPath = path16.join(agentDir, "settings.json");
  const settings = existsSync5(settingsPath) ? JSON.parse(readFileSync8(settingsPath, "utf8")) : {};
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
  const key = JSON.stringify(["registration-only/v1", path16.resolve(cwd), ...[piCli, ...extensions.map((item) => item.path)].map((file) => [file, existsSync5(file) ? statSync10(file).mtimeMs : 0])]);
  const cached = existsSync5(cacheFile) ? JSON.parse(readFileSync8(cacheFile, "utf8")) : null;
  if (cached?.key === key) return Promise.resolve(cached.tools);
  const id = `${cacheFile}
${key}`;
  if (!probes.has(id)) {
    probes.set(id, runToolProbe(extensions, piCli, cwd).then((tools) => {
      mkdirSync5(path16.dirname(cacheFile), { recursive: true });
      writeFileSync3(cacheFile, JSON.stringify({ key, tools }));
      return tools;
    }).finally(() => probes.delete(id)));
  }
  return probes.get(id);
}
function runToolProbe(extensions, piCli, cwd) {
  const loader = path16.join(path16.dirname(piCli), "core", "extensions", "loader.js");
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
  toolCache = path16.join(cwd, ".runtime", "cockpit", "worker-tool-probe.json"),
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
    WORKER_RESOURCES_CONFIG = path16.resolve(path16.dirname(fileURLToPath2(import.meta.url)), "../templates/worker-resources.json");
    IMPORT_ACCESS = Object.freeze(["off", "optional", "default_on"]);
    BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
    RUNNER_TOOLS = Object.freeze(["research_search", "research_fetch", "command_job"]);
    PI_CLI = path16.join(process.env.APPDATA || path16.join(homedir3(), "AppData", "Roaming"), "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
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
    if (path16.basename(process.argv[1] || "") === "pi_worker_resources.mjs") {
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

// ops/tools/dispatch-core/dispatch-prepare/worker.mjs
function agentConfigEntryImpl(agentType) {
  return loadRoleConfig(agentType);
}
function agentConfigEntry(agentType) {
  return deps.agentConfigEntry(agentType);
}
var init_worker = __esm({
  async "ops/tools/dispatch-core/dispatch-prepare/worker.mjs"() {
    init_tool_common();
    init_py();
    init_model_selection();
    init_seed_minimal();
    init_task_package_profiles();
    await init_pi_worker_resources();
    init_deps();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/runtime.mjs
var init_runtime = __esm({
  async "ops/tools/dispatch-core/dispatch-prepare/runtime.mjs"() {
    init_tool_common();
    init_py();
    init_model_selection();
    init_review_evidence();
    init_task_package_build();
    init_catalog();
    init_constants();
    init_py_utils();
    await init_worker();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/batch-meta.mjs
var init_batch_meta = __esm({
  "ops/tools/dispatch-core/dispatch-prepare/batch-meta.mjs"() {
    init_tool_common();
    init_py();
    init_py_utils();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/prepare-async.mjs
var init_prepare_async = __esm({
  async "ops/tools/dispatch-core/dispatch-prepare/prepare-async.mjs"() {
    init_tool_common();
    init_py();
    init_review_evidence();
    init_subagent_preload();
    init_batch_meta();
    init_constants();
    init_delivery();
    init_deps();
    init_py_utils();
    init_seed();
    await init_runtime();
    init_state();
    await init_worker();
  }
});

// ops/tools/dispatch-core/dispatch-prepare/dispatch-run.mjs
var init_dispatch_run = __esm({
  async "ops/tools/dispatch-core/dispatch-prepare/dispatch-run.mjs"() {
    init_agent_panel_launcher();
    init_model_selection();
    init_py();
    init_review_evidence();
    init_seed_minimal();
    init_subagent_preload();
    init_task_package_build();
    init_tool_common();
    await init_pi_worker_resources();
    init_batch_meta();
    init_deps();
    init_delivery();
    await init_prepare_async();
    init_py_utils();
    await init_runtime();
    init_seed();
    init_scope();
    init_state();
    await init_worker();
  }
});

// ops/tools/dispatch-core/dispatch_prepare.mjs
var init_dispatch_prepare = __esm({
  async "ops/tools/dispatch-core/dispatch_prepare.mjs"() {
    init_agent_panel_launcher();
    init_prepared_dispatch();
    init_review_evidence();
    init_catalog();
    init_delivery();
    init_deps();
    init_server();
    init_scope();
    await init_worker();
    init_task_package_build();
    init_prepared_dispatch();
    init_review_evidence();
    init_tool_common();
    init_seed_minimal();
    init_subagent_preload();
    init_task_package_lint();
    init_task_package_profiles();
    init_constants();
    init_state();
    init_server();
    init_scope();
    init_seed();
    init_delivery();
    await init_worker();
    init_catalog();
    await init_runtime();
    await init_prepare_async();
    init_batch_meta();
    await init_dispatch_run();
    init_py_utils();
    Object.assign(deps, {
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
    });
  }
});

// ops/tools/subagent_preload.mjs
init_tool_common();
init_subagent_preload();
import process10 from "node:process";

// ops/tools/subagent_preload.selftest.mjs
init_tool_common();
init_subagent_preload();
await init_dispatch_prepare();
import { mkdirSync as mkdirSync6, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";
import path17 from "node:path";
var rolePrompt = (role) => String(agentConfigEntry(role).developer_instructions || "").trim();
function selfTest() {
  const fixtureDir = path17.join(ROOT, "tmp", "subagent-preload-self-test");
  mkdirSync6(fixtureDir, { recursive: true });
  const packagePath = path17.join(fixtureDir, "preload-self-test.task-package.json");
  const evidencePath = path17.join(fixtureDir, "preload-self-test.review-evidence.json");
  const evidenceText = '{"schema_version": 1, "complete": true, "fact": "mechanical"}\n';
  writeFileSync4(evidencePath, evidenceText, "utf8");
  const evidenceRelative = path17.relative(ROOT, evidencePath).replaceAll("\\", "/");
  const generalCapability = "ops/agent-prompts/general-agent/general-default.md";
  const reviewCommonPrompt = "ops/agent-prompts/_review-common.md";
  const driftCapability = "ops/agent-prompts/semantic-review-agent/contract-drift-inspection.md";
  const acceptanceCapability = "ops/agent-prompts/verify-agent/acceptance-synthesis.md";
  const pkg = {
    task_package: {
      package_id: "preload-self-test",
      agent: {
        role: "general-agent",
        runtime_role: "general-agent",
        capability: { name: "general-default", file: generalCapability },
        required_files: ["ops/agent-prompts/_common.md", generalCapability]
      },
      goal: "self test",
      scope: { read: [], write: [], delete: [], out_of_scope: [] },
      expected_output: { mode: "message" },
      handoff_contract: { require_final_handoff: true },
      extensions: { review_evidence: { path: evidenceRelative } }
    }
  };
  writeFileSync4(packagePath, `${JSON.stringify(pkg, null, 2)}
`, "utf8");
  const rendered = renderTaskMaterialFile(packagePath);
  const compactPath = path17.join(fixtureDir, "preload-self-test-evidence-only.task-package.json");
  const compactPackage = JSON.parse(JSON.stringify(pkg));
  compactPackage.task_package.agent = {
    role: "semantic-review-agent",
    runtime_role: "semantic-review-agent",
    capability: { name: "contract-drift-inspection", file: driftCapability },
    required_files: ["ops/agent-prompts/_common.md", reviewCommonPrompt, driftCapability]
  };
  compactPackage.task_package.extensions.review_execution = { profile: "evidence_only_v1" };
  compactPackage.task_package.extensions.capability_contract = {
    contract_drift_inspection: { target_files: ["target.py"] }
  };
  Object.assign(compactPackage.task_package.expected_output, {
    mode: "file",
    file_path: "notes/verify/self-test.md",
    business_gate: "verdict"
  });
  Object.assign(compactPackage.task_package.handoff_contract, {
    handoff_file: "notes/handoffs/self-test.md",
    accept_verdicts: ["done", "needs_owner"]
  });
  writeFileSync4(compactPath, JSON.stringify(compactPackage), "utf8");
  const compactRendered = renderTaskMaterialFile(compactPath);
  compactPackage.task_package.scope.read = [evidenceRelative];
  compactPackage.task_package.tool_contract = { allowed: [] };
  writeFileSync4(compactPath, JSON.stringify(compactPackage), "utf8");
  const compactToollessRendered = renderTaskMaterialFile(compactPath);
  delete compactPackage.task_package.tool_contract;
  compactPackage.task_package.scope.read = [];
  const semanticPath = path17.join(fixtureDir, "preload-self-test-semantic.task-package.json");
  const semanticPackage = JSON.parse(JSON.stringify(compactPackage));
  semanticPackage.task_package.extensions.review_execution = { profile: "semantic_review_v2", material_mode: "index" };
  writeFileSync4(semanticPath, JSON.stringify(semanticPackage), "utf8");
  const semanticRendered = renderTaskMaterialFile(semanticPath);
  const acceptancePath = path17.join(fixtureDir, "preload-self-test-acceptance.task-package.json");
  const acceptancePackage = JSON.parse(JSON.stringify(compactPackage));
  acceptancePackage.task_package.agent = {
    role: "verify-agent",
    runtime_role: "verify-agent",
    capability: { name: "acceptance-synthesis", file: acceptanceCapability },
    required_files: ["ops/agent-prompts/_common.md", reviewCommonPrompt, acceptanceCapability]
  };
  acceptancePackage.task_package.scope.read = ["acceptance-contract.yaml", "dependency-index.json"];
  acceptancePackage.task_package.extensions.review_execution = { profile: "acceptance_synthesis_v1" };
  acceptancePackage.task_package.extensions.capability_contract = {
    acceptance_synthesis: { acceptance_ids: ["AC-01"] }
  };
  writeFileSync4(acceptancePath, JSON.stringify(acceptancePackage), "utf8");
  const acceptanceRendered = renderTaskMaterialFile(acceptancePath);
  const consultPath = path17.join(fixtureDir, "preload-self-test-consult.task-package.json");
  const consultPackage = JSON.parse(JSON.stringify(pkg));
  consultPackage.task_package.scope.read = [evidenceRelative];
  consultPackage.task_package.tool_contract = { allowed: [] };
  writeFileSync4(consultPath, JSON.stringify(consultPackage), "utf8");
  const consultRendered = renderTaskMaterialFile(consultPath);
  consultPackage.task_package.scope.read = [path17.relative(ROOT, fixtureDir).replaceAll("\\", "/")];
  writeFileSync4(consultPath, JSON.stringify(consultPackage), "utf8");
  const consultDirRendered = renderTaskMaterialFile(consultPath);
  consultPackage.task_package.tool_contract = { allowed: [" read "] };
  writeFileSync4(consultPath, JSON.stringify(consultPackage), "utf8");
  const paddedReadRendered = renderTaskMaterialFile(consultPath);
  const codeCoverageTemplate = outputTemplateFor({
    agent: { capability: { name: "code-verification" } },
    extensions: {
      review_execution: { profile: "evidence_only_v1", contract_slot: "verify" },
      capability_contract: { verify: { affected_files: ["target.py"] } }
    }
  });
  const checks = {
    render_opens_with_task: rendered.startsWith("\u672C\u6B21\u4EFB\u52A1\uFF1Aself test"),
    render_ends_with_task_card: rendered.includes("## \u4EFB\u52A1\u5361") && rendered.indexOf("## \u4EFB\u52A1\u5361") > rendered.indexOf("## \u80FD\u529B\u89C4\u5219"),
    render_points_to_package_file: rendered.includes("`preload-self-test`") && rendered.includes(path17.resolve(packagePath)),
    render_omits_inline_package: !rendered.includes('"package_id"'),
    render_omits_role_prompt: !rendered.includes(rolePrompt("general-agent")),
    render_omits_manual_handoff_template: !rendered.includes("FINAL_HANDOFF:"),
    render_file_has_common_prompt_path: rendered.includes("ops/agent-prompts/_common.md"),
    render_file_has_capability_prompt: rendered.includes("general-default"),
    render_file_has_review_evidence: rendered.includes('"fact": "mechanical"'),
    evidence_only_uses_compact_result: compactRendered.includes("review_result") && !compactRendered.includes("FINAL_HANDOFF:"),
    evidence_only_uses_target_files_marker: compactRendered.includes('"reviewed":["$target_files"]'),
    evidence_only_keeps_contract_and_required_files: [
      "### \u80FD\u529B\u5408\u540C",
      '"target_files": [',
      '<!-- subagent-required-material:start {"path":"ops/agent-prompts/_common.md"} -->'
    ].every((marker) => compactRendered.includes(marker)),
    semantic_review_uses_compact_result: semanticRendered.includes("review_result") && !semanticRendered.includes("FINAL_HANDOFF:"),
    semantic_review_uses_target_files_marker: semanticRendered.includes('"reviewed":["$target_files"]'),
    semantic_review_records_actual_scope_reads: semanticRendered.includes('"actual_reads":['),
    semantic_review_keeps_scope: semanticRendered.includes("### \u8303\u56F4"),
    acceptance_review_uses_exact_scope_paths: acceptanceRendered.includes('"reviewed":["<exact path from task_package.scope.read>"]') && !acceptanceRendered.includes('"reviewed":["$target_files"]'),
    code_verification_affected_files_use_marker: codeCoverageTemplate.includes('"reviewed":["$target_files"]'),
    render_omits_hashes: !rendered.includes("sha256:"),
    toolless_task_inlines_scope_read: consultRendered.includes(`## \u5377\u5B97\uFF1A${evidenceRelative}`) && consultRendered.includes(evidenceText.trim()) && consultRendered.includes("\u5FC5\u8BFB\uFF08\u5168\u6587\u5DF2\u5728\u4E0A\u6587\u300C\u5377\u5B97\u300D\u5404\u8282\uFF09"),
    toolless_task_expands_scope_directory: consultDirRendered.includes(`## \u5377\u5B97\uFF1A${evidenceRelative}`),
    padded_read_tool_keeps_scope_read_as_paths: !paddedReadRendered.includes("## \u5377\u5B97\uFF1A"),
    structured_review_never_inlines_scope_read: !compactToollessRendered.includes("## \u5377\u5B97\uFF1A"),
    read_capable_task_keeps_scope_read_as_paths: !rendered.includes("## \u5377\u5B97\uFF1A")
  };
  try {
    rmSync4(packagePath, { force: true });
    rmSync4(compactPath, { force: true });
    rmSync4(semanticPath, { force: true });
    rmSync4(acceptancePath, { force: true });
    rmSync4(consultPath, { force: true });
    rmSync4(evidencePath, { force: true });
    rmSync4(fixtureDir, { force: true });
  } catch {
  }
  return { status: Object.values(checks).every(Boolean) ? "ok" : "failed", checks };
}

// ops/tools/subagent_preload.mjs
var PROGRAM = "subagent_preload.mjs";
var USAGE = `usage: ${PROGRAM} [-h] [--self-test] [--format {text,json}] {render} ...`;
var DESCRIPTION = "\u8BFB\u53D6 task package \u6587\u4EF6\u5E76\u6E32\u67D3\u5B8C\u6574\u4EFB\u52A1\u6750\u6599\uFF08\u89D2\u8272\u8FD0\u884C\u63D0\u793A\u8BCD + \u516C\u5171\u63D0\u793A\u8BCD + \u80FD\u529B\u63D0\u793A\u8BCD + \u4EFB\u52A1\u5305 + \u8F93\u51FA\u6A21\u677F\uFF09\uFF0C\u4F9B direct file-ref \u6D3E\u53D1\u7684\u5B50\u4EE3\u7406\u542F\u52A8\u540E\u8BFB\u53D6\uFF1Basync \u8DEF\u7EBF\u7684\u4EFB\u52A1\u6750\u6599\u6587\u4EF6\u4E5F\u7531\u672C\u6E32\u67D3\u903B\u8F91\u751F\u6210\u3002";
var EPILOG = "\u5178\u578B\u7528\u6CD5\uFF1Anode ops/tools/subagent_preload.mjs render --package tmp/dispatch_prepare/<id>.task-package.json\n\u4F7F\u7528\u65F6\u673A\u4E0E\u8FB9\u754C\u89C1 ops/policies/runtime-tools.md";
var ArgumentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
};
var HelpRequested = class extends Error {
};
function helpText() {
  return `${USAGE}

${DESCRIPTION}

options:
  -h, --help            show this help message and exit
  --self-test           \u8FD0\u884C\u5185\u7F6E\u81EA\u6D4B\u5E76\u62A5\u544A\u68C0\u67E5\u9879\u7ED3\u679C\u3002
  --format {text,json}

subcommands:
  render --package PACKAGE [--format {text,json}]
      \u5305\u542B task_package \u7684 JSON \u6587\u4EF6\u8DEF\u5F84\uFF08task_package \u5305\u88C5\u6216\u88F8\u5BF9\u8C61\u5747\u53EF\uFF09\u3002

${EPILOG}
`;
}
function takeValue(tokens, flag, inline) {
  if (inline !== null) return inline;
  if (!tokens.length) throw new ArgumentError(`argument ${flag}: expected one argument`);
  return tokens.shift();
}
function parseArgs(argv) {
  const args = { command: null, package: null, format: "text", selfTest: false };
  const tokens = [...argv];
  let inRender = false;
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") throw new HelpRequested();
    const isFlag = token.startsWith("--");
    const equals = isFlag ? token.indexOf("=") : -1;
    const name = equals > 0 ? token.slice(0, equals) : token;
    const inline = equals > 0 ? token.slice(equals + 1) : null;
    if (!isFlag) {
      if (args.command !== null) throw new ArgumentError(`unrecognized arguments: ${token}`);
      if (token !== "render") {
        throw new ArgumentError(`argument command: invalid choice: '${token}' (choose from 'render')`);
      }
      args.command = "render";
      inRender = true;
      continue;
    }
    if (name === "--self-test") {
      if (inline !== null) throw new ArgumentError(`argument --self-test: ignored explicit argument '${inline}'`);
      args.selfTest = true;
      continue;
    }
    if (name === "--format") {
      const value = takeValue(tokens, "--format", inline);
      if (!["text", "json"].includes(value)) {
        throw new ArgumentError(`argument --format: invalid choice: '${value}' (choose from 'text', 'json')`);
      }
      args.format = value;
      continue;
    }
    if (name === "--package") {
      if (!inRender) throw new ArgumentError(`unrecognized arguments: ${token}`);
      args.package = takeValue(tokens, "--package", inline);
      continue;
    }
    throw new ArgumentError(`unrecognized arguments: ${token}`);
  }
  if (args.command === "render" && !args.package) {
    throw new ArgumentError("the following arguments are required: --package");
  }
  return args;
}
function main(argv) {
  const args = parseArgs(argv);
  try {
    if (args.selfTest) {
      const data = selfTest();
      const text2 = data.status === "ok" ? "subagent_preload self-test passed" : "subagent_preload self-test failed";
      return emit(data, args.format, text2);
    }
    if (args.command === "render") {
      const context = renderTaskMaterialFile(resolveLikePython(pathlibJoin(ROOT, args.package)));
      const data = { status: "ok", package: args.package, additional_context: context };
      return emit(data, args.format, context);
    }
    process10.stdout.write(helpText());
    return 2;
  } catch (error) {
    if (error instanceof ToolError || error?.name === "ToolError") {
      return emit({ status: "failed", error: String(error.message) }, args.format, `failed: ${error.message}`);
    }
    throw error;
  }
}
try {
  process10.exitCode = main(process10.argv.slice(2));
} catch (error) {
  if (error instanceof HelpRequested) {
    process10.stdout.write(helpText());
    process10.exitCode = 0;
  } else if (error instanceof ArgumentError) {
    process10.stderr.write(`${USAGE}
${PROGRAM}: error: ${error.message}
`);
    process10.exitCode = 2;
  } else {
    throw error;
  }
}
export {
  main,
  parseArgs
};
