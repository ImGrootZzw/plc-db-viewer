/* =========================================================================
 * dbparse.js — 西门子 DB 块源文件解析器（纯逻辑，无 DOM）
 * 支持：TIA Portal / STEP7 V5 导出的文本源 .db
 * ========================================================================= */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- 类型表 */
  // bits: 位宽; align: 对齐字节; cat: 统计分类
  const ELEM = {
    bool:      { bits: 1,  align: 1, cat: 'bool' },
    byte:      { bits: 8,  align: 1, cat: 'int' },
    char:      { bits: 8,  align: 1, cat: 'char' },
    usint:     { bits: 8,  align: 1, cat: 'int' },
    sint:      { bits: 8,  align: 1, cat: 'int' },
    word:      { bits: 16, align: 2, cat: 'int' },
    uint:      { bits: 16, align: 2, cat: 'int' },
    int:       { bits: 16, align: 2, cat: 'int' },
    s5time:    { bits: 16, align: 2, cat: 'time' },
    date:      { bits: 16, align: 2, cat: 'time' },
    timer:     { bits: 16, align: 2, cat: 'time' },
    counter:   { bits: 16, align: 2, cat: 'int' },
    dword:     { bits: 32, align: 4, cat: 'int' },
    udint:     { bits: 32, align: 4, cat: 'int' },
    dint:      { bits: 32, align: 4, cat: 'int' },
    real:      { bits: 32, align: 4, cat: 'real' },
    time:      { bits: 32, align: 4, cat: 'time' },
    tod:       { bits: 32, align: 4, cat: 'time' },
    pointer:   { bits: 48, align: 2, cat: 'misc' },
    any:       { bits: 80, align: 2, cat: 'misc' },
    lword:     { bits: 64, align: 8, cat: 'int' },
    ulint:     { bits: 64, align: 8, cat: 'int' },
    lint:      { bits: 64, align: 8, cat: 'int' },
    lreal:     { bits: 64, align: 8, cat: 'real' },
    ltime:     { bits: 64, align: 8, cat: 'time' },
    dt:        { bits: 64, align: 2, cat: 'time' },
    dtl:       { bits: 96, align: 2, cat: 'time' },
    wchar:     { bits: 16, align: 2, cat: 'char' },
    iec_timer:   { bits: 128, align: 2, cat: 'time' },
    iec_counter: { bits: 64,  align: 2, cat: 'int' }
  };

  const ALIAS = {
    'bool': 'bool',
    'byte': 'byte', 'char': 'char',
    'usint': 'usint', 'sint': 'sint',
    'word': 'word', 'uint': 'uint', 'int': 'int',
    's5time': 's5time', 's5time_': 's5time',
    'date': 'date', 'timer': 'timer', 'counter': 'counter',
    'dword': 'dword', 'udint': 'udint', 'dint': 'dint', 'real': 'real',
    'time': 'time',
    'tod': 'tod', 'time_of_day': 'tod', 'timeofday': 'tod',
    'pointer': 'pointer', 'any': 'any', 'variant': null, 'remote': null,
    'lword': 'lword', 'ulint': 'ulint', 'lint': 'lint', 'lreal': 'lreal',
    'ltime': 'ltime', 'ltime_of_day': 'ltime',
    'dt': 'dt', 'date_and_time': 'dt', 'dateandtime': 'dt',
    'dtl': 'dtl',
    'wchar': 'wchar',
    'iec_timer': 'iec_timer', 'timer_iec': 'iec_timer',
    'iec_counter': 'iec_counter', 'counter_iec': 'iec_counter'
  };

  const TYPE_LABEL = {
    bool: 'Bool', byte: 'Byte', char: 'Char', usint: 'USInt', sint: 'SInt',
    word: 'Word', uint: 'UInt', int: 'Int', s5time: 'S5Time', date: 'Date',
    timer: 'Timer', counter: 'Counter', dword: 'DWord', udint: 'UDInt',
    dint: 'DInt', real: 'Real', time: 'Time', tod: 'Time_Of_Day',
    pointer: 'Pointer', any: 'Any', lword: 'LWord', ulint: 'ULInt',
    lint: 'LInt', lreal: 'LReal', ltime: 'LTime', dt: 'Date_And_Time',
    dtl: 'DTL', wchar: 'WChar', iec_timer: 'IEC_TIMER',
    iec_counter: 'IEC_COUNTER'
  };

  /* --------------------------------------------------------------- 工具函数 */
  const lower = (s) => String(s).toLowerCase();

  function bcd(b) { return ((b >> 4) & 0x0f) * 10 + (b & 0x0f); }
  function pad2(n) { return String(n).padStart(2, '0'); }

  function ceilTo(v, unit) { return Math.ceil(v / unit) * unit; }

  /* ----------------------------------------------------------- 注释剥离 */
  function splitComments(src) {
    src = String(src).replace(/^﻿/, '');
    const lines = src.split(/\r\n|\n|\r/);
    const codeLines = [];
    const comments = [];
    let inBlock = null;

    for (let ln = 0; ln < lines.length; ln++) {
      const s = lines[ln];
      let out = '';
      let cmt = '';
      let inStr = false, inQid = false;
      let i = 0;
      while (i < s.length) {
        const c = s[i];
        if (inBlock) {
          if (inBlock === '(*' && s.startsWith('*)', i)) { i += 2; inBlock = null; continue; }
          if (inBlock === '/*' && s.startsWith('*/', i)) { i += 2; inBlock = null; continue; }
          cmt += c; i++; continue;
        }
        if (inStr) { out += c; if (c === "'") inStr = false; i++; continue; }
        if (inQid) { out += c; if (c === '"') inQid = false; i++; continue; }
        if (c === "'") { inStr = true; out += c; i++; continue; }
        if (c === '"') { inQid = true; out += c; i++; continue; }
        if (s.startsWith('//', i)) { cmt += ' ' + s.slice(i + 2); break; }
        if (s.startsWith('(*', i)) { inBlock = '(*'; i += 2; continue; }
        if (s.startsWith('/*', i)) { inBlock = '/*'; i += 2; continue; }
        out += c; i++;
      }
      codeLines.push(out);
      comments.push(cmt.trim());
    }
    return { code: codeLines.join('\n'), comments, lines: codeLines };
  }

  /* --------------------------------------------------------------- 词法分析 */
  function tokenize(code) {
    const toks = [];
    let i = 0, line = 1;
    const n = code.length;

    while (i < n) {
      const c = code[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1, s = '';
        while (j < n && code[j] !== quote) { if (code[j] === '\n') line++; s += code[j++]; }
        toks.push({ t: quote === '"' ? 'qid' : 'str', v: s, line });
        i = j + 1;
        continue;
      }

      if (/[0-9]/.test(c)) {
        const m = /^[0-9][0-9A-Za-z_]*(?:#[0-9A-Za-z_:.+\-]+)?(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(code.slice(i));
        toks.push({ t: 'num', v: m[0], line });
        i += m[0].length;
        continue;
      }

      if (/[A-Za-z_一-龥]/.test(c)) {
        const m = /^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*/.exec(code.slice(i));
        const word = m[0];
        let end = i + word.length;
        // 带 # 的类型化字面量: T#1s, S5T#5s, B#16#FF, D#2020-01-01
        if (code[end] === '#') {
          end++;
          const m2 = /^[0-9A-Za-z_:.+\-#]+/.exec(code.slice(end));
          if (m2) end += m2[0].length;
          toks.push({ t: 'num', v: code.slice(i, end), line });
          i = end;
          continue;
        }
        toks.push({ t: 'id', v: word, line });
        i = end;
        continue;
      }

      if (c === '#' ) { toks.push({ t: 'sym', v: '#', line }); i++; continue; }

      const three = code.substr(i, 3);
      const two = code.substr(i, 2);
      if (two === ':=' || two === '..' || two === '=>' || two === '<=' || two === '>=' || two === '<>') {
        toks.push({ t: 'sym', v: two, line }); i += 2; continue;
      }
      if (';:,.[](){}<>+-*/=@&|!%^~'.includes(c)) {
        toks.push({ t: 'sym', v: c, line }); i++; continue;
      }
      i++; // 无法识别的字符直接跳过
    }
    return toks;
  }

  /* --------------------------------------------------------------- 解析器 */
  function Parser(code, comments) {
    this.toks = tokenize(code);
    this.pos = 0;
    this.comments = comments || [];
    this.warnings = [];
    this.uid = 0;
  }

  Parser.prototype.peek = function (k) { return this.toks[this.pos + (k || 0)]; };
  Parser.prototype.next = function () { return this.toks[this.pos++]; };
  Parser.prototype.eof = function () { return this.pos >= this.toks.length; };

  Parser.prototype.isId = function (tok, name) {
    return tok && tok.t === 'id' && lower(tok.v) === lower(name);
  };
  Parser.prototype.isSym = function (tok, s) {
    return tok && tok.t === 'sym' && tok.v === s;
  };
  Parser.prototype.skipSym = function (s) {
    if (this.isSym(this.peek(), s)) { this.pos++; return true; }
    return false;
  };
  Parser.prototype.warn = function (msg, line) {
    this.warnings.push({ message: msg, line: line || null });
  };

  Parser.prototype.newNode = function (name) {
    return {
      id: ++this.uid,
      name: name,
      kind: 'elem',
      elemKey: null,
      typeName: '',
      children: null,
      elem: null,
      dims: null,
      count: 0,
      comment: '',
      init: null,
      line: null,
      offsetBits: 0,
      bitPacked: false
    };
  };

  /* ---- 顶层：一个文件可以包含多个块 ---- */
  Parser.prototype.parseFile = function () {
    const blocks = [];
    while (!this.eof()) {
      const tok = this.peek();
      if (this.isId(tok, 'DATA_BLOCK') || this.isId(tok, 'FUNCTION_BLOCK') ||
          this.isId(tok, 'ORGANIZATION_BLOCK') || this.isId(tok, 'FUNCTION')) {
        if (this.isId(tok, 'DATA_BLOCK')) blocks.push(this.parseDataBlock());
        else this.skipBlock();
      } else if (this.isId(tok, 'TYPE')) {
        const udt = this.parseTypeBlock();
        if (udt) {
          if (!this.udts) this.udts = {};
          this.udts[lower(udt.name)] = udt;
        }
      } else {
        this.pos++;
      }
    }
    return { blocks, udts: this.udts || {}, warnings: this.warnings };
  };

  Parser.prototype.skipBlock = function () {
    const stop = ['END_FUNCTION_BLOCK', 'END_ORGANIZATION_BLOCK', 'END_FUNCTION'];
    while (!this.eof()) {
      const t = this.next();
      if (t.t === 'id' && stop.includes(t.v.toUpperCase())) break;
    }
  };

  /* ---- UDT / TYPE 块 ---- */
  Parser.prototype.parseTypeBlock = function () {
    this.next(); // TYPE
    let name = 'UDT';
    const t = this.peek();
    if (t && (t.t === 'qid' || t.t === 'id')) {
      name = t.v;
      this.pos++;
      if (this.isId(this.peek(), 'UDT')) { /* TYPE UDT 10 */ }
    }
    if (this.isId(this.peek(), 'UDT')) this.pos++;
    const num = this.peek();
    if (num && num.t === 'num') { name = name === 'UDT' ? ('UDT' + num.v) : name; this.pos++; }

    const node = this.newNode(name);
    node.kind = 'struct';
    node.typeName = name;
    node.children = [];

    while (!this.eof()) {
      const tok = this.peek();
      if (this.isId(tok, 'VERSION')) { this.pos += 3; continue; }
      if (this.isSym(tok, '{')) { this.parseAttrBlock(); continue; }
      if (this.isId(tok, 'STRUCT')) {
        this.pos++;
        node.children = node.children.concat(this.parseDeclList(['END_STRUCT']));
        this.skipEndKeyword('END_STRUCT');
        this.skipSym(';');
        continue;
      }
      if (this.isId(tok, 'END_TYPE')) { this.pos++; break; }
      if (this.isSym(tok, ';')) { this.pos++; continue; }
      this.pos++;
    }
    return node;
  };

  Parser.prototype.skipEndKeyword = function (kw) {
    if (this.isId(this.peek(), kw)) { this.pos++; return true; }
    // 容错：往后找一找
    for (let k = 0; k < 4; k++) {
      if (this.isId(this.peek(k), kw)) { this.pos += k + 1; return true; }
    }
    return false;
  };

  /* ---- DATA_BLOCK ---- */
  Parser.prototype.parseDataBlock = function () {
    this.next(); // DATA_BLOCK

    const block = {
      name: '', dbNumber: null, optimized: false, retain: null,
      version: '', title: '', author: '', family: '',
      children: [], attrs: {}, sizeBits: 0, sizeBytes: 0, maxAlign: 1,
      beginAssignments: [], source: 'source', warnings: []
    };

    // 名称 / 编号
    let t = this.peek();
    if (this.isId(t, 'DB')) {
      this.pos++;
      const num = this.peek();
      if (num && num.t === 'num') { block.dbNumber = parseInt(num.v, 10); this.pos++; }
    }
    t = this.peek();
    if (t && (t.t === 'qid' || t.t === 'id') && !this.isBlockKeyword(t)) {
      block.name = t.v; this.pos++;
    }
    if (this.isId(this.peek(), 'DB')) {
      this.pos++;
      const num = this.peek();
      if (num && num.t === 'num') { block.dbNumber = parseInt(num.v, 10); this.pos++; }
    }

    // 头部属性
    while (!this.eof()) {
      const tok = this.peek();
      if (!tok) break;

      if (this.isSym(tok, '{')) { this.parseAttrBlock(block.attrs, block); continue; }
      if (this.isId(tok, 'VERSION')) {
        this.pos++;
        this.skipSym(':');
        const v = this.peek();
        if (v && (v.t === 'num' || v.t === 'id')) { block.version = v.v; this.pos++; }
        continue;
      }
      if (this.isId(tok, 'NON_RETAIN')) { block.retain = false; this.pos++; continue; }
      if (this.isId(tok, 'RETAIN')) { block.retain = true; this.pos++; continue; }
      // 不带花括号的块属性：S7_Optimized_Access := 'TRUE'
      if (tok.t === 'id' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.v) &&
          (this.isSym(this.peek(1), ':=') || this.isSym(this.peek(1), '=')) &&
          !['title', 'author', 'family', 'name', 'version', 'code_version'].includes(lower(tok.v))) {
        const key = lower(tok.v);
        this.pos += 2;
        const val = this.peek();
        if (val) { block.attrs[key] = val.v; this.pos++; }
        continue;
      }
      if (this.isId(tok, 'TITLE') || this.isId(tok, 'AUTHOR') || this.isId(tok, 'FAMILY') || this.isId(tok, 'NAME')) {
        const key = lower(tok.v);
        const line = tok.line;
        this.pos++;
        this.skipSym('=');
        this.skipSym(':');
        const parts = [];
        while (!this.eof() && this.peek().line === line && !this.isBlockKeyword(this.peek())) {
          parts.push(this.next().v);
        }
        const val = parts.join(' ').trim();
        if (key === 'title') block.title = val;
        else if (key === 'author') block.author = val;
        else if (key === 'family') block.family = val;
        else if (key === 'name' && !block.name) block.name = val;
        continue;
      }
      if (this.isId(tok, 'VAR') || this.isId(tok, 'STRUCT')) {
        if (this.isId(tok, 'VAR')) {
          this.pos++;
          while (this.isId(this.peek(), 'RETAIN') || this.isId(this.peek(), 'NON_RETAIN') ||
                 this.isId(this.peek(), 'CONSTANT')) {
            if (this.isId(this.peek(), 'CONSTANT')) block.hasConstants = true;
            this.pos++;
          }
          block.children = this.parseDeclList(['END_VAR']);
          this.skipEndKeyword('END_VAR');
          this.skipSym(';');
        } else {
          this.pos++;
          block.children = this.parseDeclList(['END_STRUCT']);
          this.skipEndKeyword('END_STRUCT');
          this.skipSym(';');
        }
        continue;
      }
      if (this.isId(tok, 'BEGIN')) {
        this.pos++;
        this.parseBegin(block);
        continue;
      }
      if (this.isId(tok, 'END_DATA_BLOCK')) { this.pos++; break; }
      if (this.isId(tok, 'DATA_BLOCK')) break;
      this.pos++;
    }

    if (block.attrs['s7_optimized_access'] !== undefined) {
      const v = lower(String(block.attrs['s7_optimized_access']));
      block.optimized = (v === 'true' || v === '1');
    }
    if (!block.name && block.dbNumber !== null) block.name = 'DB' + block.dbNumber;
    if (!block.name) block.name = 'DB';

    return block;
  };

  Parser.prototype.isBlockKeyword = function (tok) {
    if (!tok || tok.t !== 'id') return false;
    const v = tok.v.toUpperCase();
    return ['VAR', 'STRUCT', 'BEGIN', 'END_VAR', 'END_STRUCT', 'END_DATA_BLOCK',
      'DATA_BLOCK', 'VERSION', 'NON_RETAIN', 'RETAIN', 'TITLE', 'AUTHOR', 'FAMILY',
      'TYPE', 'END_TYPE', 'KNOW_HOW_PROTECT', 'CONSTANT'].includes(v);
  };

  Parser.prototype.parseAttrBlock = function (attrs, block) {
    // 调用前不消费 '{'
    this.pos++; // {
    while (!this.eof() && !this.isSym(this.peek(), '}')) {
      if (this.isSym(this.peek(), ';')) { this.pos++; continue; }
      const keyTok = this.peek();
      if (!keyTok) break;
      const key = lower(keyTok.v);
      this.pos++;
      if (this.isSym(this.peek(), ':=') || this.isSym(this.peek(), '=')) {
        this.pos++;
        const valTok = this.peek();
        if (valTok) {
          if (attrs) attrs[key] = valTok.v;
          this.pos++;
        }
      } else if (attrs) {
        attrs[key] = true;
      }
    }
    this.skipSym('}');
  };

  /* ---- 声明列表 ---- */
  Parser.prototype.parseDeclList = function (stops) {
    const out = [];
    const stopSet = (stops || []).map((s) => s.toUpperCase());
    let guard = 0;

    while (!this.eof() && guard++ < 200000) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.t === 'id' && stopSet.includes(tok.v.toUpperCase())) break;
      if (this.isSym(tok, ';')) { this.pos++; continue; }
      if (this.isSym(tok, '}')) { this.pos++; continue; }
      if (this.isId(tok, 'BEGIN') || this.isId(tok, 'END_DATA_BLOCK')) break;

      const decl = this.parseDeclaration();
      if (decl) out.push(decl);
      else this.pos++; // 防止死循环
    }
    return out;
  };

  Parser.prototype.parseDeclaration = function () {
    const names = [];
    let firstTok = this.peek();
    let guard = 0;

    while (!this.eof() && guard++ < 200) {
      const tok = this.peek();
      if (!tok) return null;
      if (tok.t === 'id' || tok.t === 'qid') {
        names.push(tok.v);
        this.pos++;
        // 名字后的属性块
        while (this.isSym(this.peek(), '{')) this.parseAttrBlock(null);
        if (this.isSym(this.peek(), ',')) { this.pos++; continue; }
        break;
      }
      return null;
    }
    if (!names.length) return null;

    if (!this.skipSym(':')) {
      // 不是标准声明（可能是语句），跳过到分号
      this.warn('无法识别的声明，已跳过：' + names.join(','), firstTok.line);
      while (!this.eof() && !this.isSym(this.peek(), ';') && !this.isSym(this.peek(), '}')) this.pos++;
      this.skipSym(';');
      return null;
    }

    const typeNode = this.parseType();
    if (!typeNode) {
      this.warn('类型解析失败：' + names.join(','), firstTok.line);
      while (!this.eof() && !this.isSym(this.peek(), ';')) this.pos++;
      this.skipSym(';');
      return null;
    }

    let init = null;
    if (this.isSym(this.peek(), ':=')) {
      this.pos++;
      init = this.parseValueList();
    }

    let endLine = firstTok.line;
    while (this.isSym(this.peek(), '{')) this.parseAttrBlock(null);
    if (this.isSym(this.peek(), ';')) { endLine = this.peek().line; this.pos++; }

    const comment = this.pickComment(endLine);

    // 类型节点已经是一个节点，套上名字
    typeNode.name = names[0];
    typeNode.comment = comment;
    typeNode.line = firstTok.line;
    typeNode.init = init;

    if (names.length > 1) {
      // 一行声明多个变量：克隆结构（数组/结构体较少见，但语法允许）
      const group = this.newNode(names[0]);
      group.kind = 'group';
      group.typeName = '';
      group.children = [];
      for (const nm of names) {
        const clone = cloneNode(typeNode);
        clone.name = nm;
        group.children.push(clone);
      }
      return group;
    }
    return typeNode;
  };

  Parser.prototype.pickComment = function (line) {
    if (!line) return '';
    const direct = this.comments[line - 1];
    if (direct && direct.trim()) return direct.trim();
    for (let l = line - 2; l >= Math.max(0, line - 4); l--) {
      const c = this.comments[l];
      const code = (this.codeLines && this.codeLines[l] || '').trim();
      if (c && c.trim() && !code) return c.trim();
    }
    return '';
  };

  /* ---- 类型 ---- */
  Parser.prototype.parseType = function () {
    const tok = this.peek();
    if (!tok) return null;

    if (tok.t === 'id' && lower(tok.v) === 'struct') {
      this.pos++;
      const node = this.newNode('');
      node.kind = 'struct';
      node.typeName = 'Struct';
      node.children = this.parseDeclList(['END_STRUCT']);
      this.skipEndKeyword('END_STRUCT');
      return node;
    }

    if (tok.t === 'id' && lower(tok.v) === 'array') {
      this.pos++;
      this.skipSym('[');
      const dims = [];
      let guard = 0;
      while (!this.eof() && !this.isSym(this.peek(), ']') && guard++ < 20) {
        const lo = this.parseExprUntil(['..', ',', ']']);
        if (!this.isSym(this.peek(), '..')) break;
        this.pos++;
        const hi = this.parseExprUntil([',', ']']);
        dims.push({ lo: lo, hi: hi });
        if (this.isSym(this.peek(), ',')) { this.pos++; continue; }
        break;
      }
      this.skipSym(']');
      if (this.isId(this.peek(), 'OF')) this.pos++;
      const elem = this.parseType();
      if (!elem) return null;
      const node = this.newNode('');
      node.kind = 'array';
      node.typeName = 'Array';
      node.elem = elem;
      node.dims = dims;
      node.count = dims.reduce((acc, d) => {
        const lo = evalInt(d.lo), hi = evalInt(d.hi);
        if (lo === null || hi === null || hi < lo) return acc === 0 ? 1 : acc;
        return acc * (hi - lo + 1);
      }, 1);
      return node;
    }

    if (tok.t === 'id' && (lower(tok.v) === 'string' || lower(tok.v) === 'wstring')) {
      const isW = lower(tok.v) === 'wstring';
      this.pos++;
      let len = 254;
      if (this.isSym(this.peek(), '[')) {
        this.pos++;
        const v = this.parseExprUntil([']']);
        const n = evalInt(v);
        if (n !== null) len = n;
        this.skipSym(']');
      }
      const node = this.newNode('');
      node.kind = 'string';
      node.elemKey = isW ? 'wstring' : 'string';
      node.strLen = len;
      node.isWide = isW;
      node.typeName = (isW ? 'WString' : 'String') + '[' + len + ']';
      return node;
    }

    if (tok.t === 'id' || tok.t === 'qid') {
      this.pos++;
      let name = tok.v;
      // 可能是限定名 A.B
      while (this.isSym(this.peek(), '.') && this.peek(1) && this.peek(1).t === 'id') {
        this.pos++;
        name += '.' + this.next().v;
      }
      const node = this.newNode('');
      node.kind = 'ref';
      node.refName = name;
      node.typeName = name;
      return node;
    }

    return null;
  };

  Parser.prototype.parseExprUntil = function (stops) {
    const out = [];
    let depth = 0;
    while (!this.eof()) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.t === 'sym') {
        if (tok.v === '(' || tok.v === '[') depth++;
        if (tok.v === ')' || tok.v === ']') {
          if (depth === 0) break;
          depth--;
        }
        if (depth === 0 && stops.includes(tok.v)) break;
      }
      out.push(tok.v);
      this.pos++;
    }
    return out;
  };

  Parser.prototype.parseValueList = function () {
    const values = [];
    let cur = [];
    let depth = 0;
    let guard = 0;

    while (!this.eof() && guard++ < 100000) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.t === 'sym') {
        if (tok.v === '[' || tok.v === '(' || tok.v === '{') depth++;
        else if (tok.v === ']' || tok.v === ')' || tok.v === '}') { if (depth > 0) depth--; }
        else if (depth === 0 && tok.v === ';') break;
        else if (depth === 0 && tok.v === ',') {
          values.push(cur.join(' ').trim());
          cur = [];
          this.pos++;
          continue;
        }
      }
      cur.push(tok.v);
      this.pos++;
    }
    if (cur.length) values.push(cur.join(' ').trim());
    return values.filter((v) => v !== '');
  };

  /* ---- BEGIN 段：取赋值语句 ---- */
  Parser.prototype.parseBegin = function (block) {
    let guard = 0;
    while (!this.eof() && guard++ < 200000) {
      const tok = this.peek();
      if (!tok) break;
      if (this.isId(tok, 'END_DATA_BLOCK')) break;
      if (this.isId(tok, 'DATA_BLOCK')) break;

      // 读取一条语句
      const stmt = [];
      let depth = 0;
      while (!this.eof()) {
        const t = this.peek();
        if (!t) break;
        if (t.t === 'sym') {
          if (t.v === '(' || t.v === '[') depth++;
          if (t.v === ')' || t.v === ']') depth--;
          if (t.v === ';' && depth <= 0) { this.pos++; break; }
        }
        stmt.push(t);
        this.pos++;
        if (this.isId(t, 'END_DATA_BLOCK')) { stmt.pop(); break; }
      }
      if (!stmt.length) continue;

      const arrow = stmt.findIndex((s) => s.t === 'sym' && (s.v === ':=' || s.v === '='));
      if (arrow <= 0) {
        const head = stmt[0];
        if (head && head.t === 'id') {
          const kw = head.v.toUpperCase();
          if (['IF', 'FOR', 'WHILE', 'REPEAT', 'CASE', '//'].includes(kw)) {
            this.warn('BEGIN 段包含逻辑语句 ' + kw + '，已忽略', head.line);
          }
        }
        continue;
      }

      const targetToks = stmt.slice(0, arrow);
      const valueToks = stmt.slice(arrow + 1);
      const path = parsePathTokens(targetToks);
      const raw = valueToks.map((t) => t.v).join(' ').trim();
      if (path && raw) {
        block.beginAssignments.push({ path, raw, line: stmt[0].line });
      }
    }
  };

  function parsePathTokens(toks) {
    // 形如 "DB".Var[1].Sub -> [{name},{idx:[..]},...]
    const segs = [];
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (t.t === 'qid' || t.t === 'id') {
        if (segs.length && segs[segs.length - 1].indexes) {
          // 名称必须直接跟在 . 之后
        }
        segs.push({ name: t.v, indexes: null });
        i++;
        continue;
      }
      if (t.t === 'sym' && t.v === '.' ) { i++; continue; }
      if (t.t === 'sym' && t.v === '[') {
        const idx = [];
        i++;
        let cur = [];
        let depth = 0;
        while (i < toks.length) {
          const s = toks[i];
          if (s.t === 'sym' && s.v === '[') depth++;
          if (s.t === 'sym' && s.v === ']') {
            if (depth === 0) { i++; break; }
            depth--;
          }
          if (depth === 0 && s.t === 'sym' && s.v === ',') { idx.push(evalInt(cur)); cur = []; i++; continue; }
          cur.push(s.v);
          i++;
        }
        if (cur.length) idx.push(evalInt(cur));
        if (segs.length) segs[segs.length - 1].indexes = idx;
        continue;
      }
      i++;
    }
    // 去掉最前面的 DB 名（如果和块名一致）
    return segs;
  }

  function evalInt(toks) {
    if (toks === null || toks === undefined) return null;
    if (typeof toks === 'number') return isFinite(toks) ? toks : null;
    const s = Array.isArray(toks) ? toks.join(' ') : String(toks);
    const trimmed = s.trim();
    if (!trimmed) return null;
    if (/^[+-]?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^[+-]?\d+#([0-9A-Fa-f]+)$/.test(trimmed)) {
      const m = /^([+-]?)(\d+)#([0-9A-Fa-f]+)$/.exec(trimmed);
      return parseInt(m[3], parseInt(m[2], 10));
    }
    if (/^16#[0-9A-Fa-f]+$/i.test(trimmed)) return parseInt(trimmed.slice(3), 16);
    return null;
  }

  /* ------------------------------------------------------------- 引用解析 */
  function resolveRefs(nodes, udts, warnings, seen) {
    const stack = seen || [];
    for (const n of nodes) {
      if (n.kind === 'group') { resolveRefs(n.children, udts, warnings, stack); continue; }
      if (n.kind === 'array') { resolveRefs([n.elem], udts, warnings, stack); continue; }
      if (n.kind === 'struct') { resolveRefs(n.children || [], udts, warnings, stack); continue; }
      if (n.kind !== 'ref') continue;

      const key = lower(n.refName).replace(/^"|"$/g, '');
      const simple = key.split('.').pop();

      if (ALIAS[key] !== undefined) {
        const a = ALIAS[key];
        if (a) { n.kind = 'elem'; n.elemKey = a; n.typeName = TYPE_LABEL[a]; continue; }
      }
      if (ALIAS[simple] !== undefined && ALIAS[simple]) {
        const a = ALIAS[simple];
        n.kind = 'elem'; n.elemKey = a; n.typeName = TYPE_LABEL[a]; continue;
      }
      if (udts && udts[simple]) {
        if (stack.includes(simple)) {
          warnings.push('UDT 循环引用：' + simple);
          n.kind = 'unknown'; n.typeName = n.refName;
          continue;
        }
        const tpl = udts[simple];
        n.kind = 'struct';
        n.typeName = n.refName;
        n.children = cloneNode(tpl).children || [];
        resolveRefs(n.children, udts, warnings, stack.concat([simple]));
        continue;
      }
      n.kind = 'unknown';
      n.typeName = n.refName;
      warnings.push('未定义类型 "' + n.refName + '"（如为 UDT，请一并上传 UDT 源文件）');
    }
  }

  function cloneNode(n) {
    const c = {};
    for (const k of Object.keys(n)) {
      if (k === 'children') c.children = (n.children || []).map(cloneNode);
      else if (k === 'elem') c.elem = n.elem ? cloneNode(n.elem) : null;
      else if (k === 'dims') c.dims = n.dims ? n.dims.map((d) => ({ lo: d.lo.slice(), hi: d.hi.slice() })) : null;
      else if (k === 'init') c.init = n.init ? n.init.slice() : null;
      else if (k === 'id') c.id = 0;
      else c[k] = n[k];
    }
    return c;
  }

  /* --------------------------------------------------------------- 布局计算 */
  function buildLayout(block, opts) {
    opts = opts || {};
    const maxAlign = opts.maxAlign || 4;
    const packed = opts.packed === true;

    function sizeOf(node) {
      if (node._sz) return node._sz;
      let sz;
      if (node.kind === 'elem') {
        const t = ELEM[node.elemKey];
        sz = { bits: t.bits, align: t.align };
      } else if (node.kind === 'string') {
        const unitBits = node.isWide ? 16 : 8;
        sz = { bits: (node.strLen + 2) * unitBits, align: node.isWide ? 2 : 1 };
      } else if (node.kind === 'unknown') {
        sz = { bits: 16, align: 2 };
      } else if (node.kind === 'group') {
        let cur = { byte: 0, bit: 0 };
        cur = place(node.children, cur, false);
        let bits = cur.byte * 8 + cur.bit;
        let align = 1;
        for (const c of node.children) align = Math.max(align, Math.min(sizeOf(c).align, packed ? 1 : maxAlign));
        bits = ceilTo(Math.ceil(bits / 8) * 8, align * 8);
        sz = { bits, align };
      } else if (node.kind === 'struct') {
        let cur = { byte: 0, bit: 0 };
        cur = place(node.children || [], cur, false);
        let bits = cur.byte * 8 + cur.bit;
        let align = 1;
        for (const c of (node.children || [])) align = Math.max(align, Math.min(sizeOf(c).align, packed ? 1 : maxAlign));
        bits = ceilTo(Math.ceil(bits / 8) * 8, align * 8);
        sz = { bits, align };
      } else if (node.kind === 'array') {
        const e = sizeOf(node.elem);
        const align = Math.min(e.align, packed ? 1 : maxAlign);
        if (e.bits === 1) sz = { bits: node.count, align: 1, bitPacked: true };
        else {
          const stride = ceilTo(e.bits, align * 8);
          sz = { bits: stride * node.count, align: align };
        }
      } else {
        sz = { bits: 16, align: 2 };
      }
      node._sz = sz;
      return sz;
    }

    function place(nodes, cur, assign, containerAbs) {
      for (const node of nodes) {
        const sz = sizeOf(node);
        if (sz.bits === 1 || sz.bitPacked) {
          const bitPos = cur.byte * 8 + cur.bit;
          if (assign) { node.offsetBits = bitPos; node.relBits = bitPos - containerAbs; }
          // 布尔数组：也要算步长/维度，便于按元素取偏移
          if (assign && node.kind === 'array') assignArray(node, bitPos, sizeOf, place);
          const total = bitPos + sz.bits;
          cur.byte = Math.floor(total / 8);
          cur.bit = total % 8;
          continue;
        }
        if (cur.bit) { cur.bit = 0; cur.byte++; }
        const a = Math.max(1, Math.min(sz.align, packed ? 1 : maxAlign)) * 8;
        const startBits = Math.ceil(cur.byte * 8 / a) * a;
        cur.byte = startBits / 8;
        cur.bit = 0;
        if (assign) { node.offsetBits = startBits; node.relBits = startBits - containerAbs; }

        if (node.kind === 'struct' || node.kind === 'group') {
          place(node.children || [], { byte: startBits / 8, bit: 0 }, assign, startBits);
        } else if (node.kind === 'array' && assign) {
          assignArray(node, startBits, sizeOf, place);
        }

        const end = startBits + sz.bits;
        cur.byte = Math.floor(end / 8);
        cur.bit = end % 8;
      }
      return cur;
    }

    // 计算整个块
    const cur = { byte: 0, bit: 0 };
    place(block.children, cur, true, 0);
    let totalBits = cur.byte * 8 + cur.bit;
    totalBits = ceilTo(Math.ceil(totalBits / 8) * 8, 8);
    block.sizeBits = totalBits;
    block.sizeBytes = totalBits / 8;

    let maxA = 1;
    for (const c of block.children) maxA = Math.max(maxA, sizeOf(c).align);
    block.maxAlign = packed ? 1 : Math.min(maxA, maxAlign);
    block.sizeBytes = ceilTo(block.sizeBytes, block.maxAlign);
    block.sizeBits = block.sizeBytes * 8;
    return block;
  }

  function assignArray(node, baseBits, sizeOf, place) {
    // 计算步长，并给数组元素模板分配“相对 0”的内部偏移
    node.baseBits = baseBits;
    const e = sizeOf(node.elem);
    node.elemBits = e.bits;
    node.strideBits = e.bits === 1 ? 0 : ceilTo(e.bits, Math.max(1, e.align) * 8);
    if (node.elem.kind === 'struct' || node.elem.kind === 'group') {
      place([node.elem], { byte: 0, bit: 0 }, true, 0);
    }
    // 多维下标 -> 线性序号
    node.dimsInfo = (node.dims || []).map((d) => {
      const lo = evalInt(d.lo), hi = evalInt(d.hi);
      return { lo: lo === null ? 1 : lo, hi: hi === null ? (lo === null ? 1 : lo) : hi };
    });
  }

  /* ------------------------------------------------------- 元素偏移 / 遍历 */
  function arrayElemOffsetBits(node, idx) {
    const stride = node.elemBits === 1 ? 1 : (node.strideBits || 0);
    return (node.offsetBits || 0) + idx * stride;
  }

  function arrayLinearIndex(node, idxes) {
    // 行主序：最后一维变化最快
    const dims = node.dimsInfo || [];
    let lin = 0;
    for (let d = 0; d < dims.length; d++) {
      const size = dims[d].hi - dims[d].lo + 1;
      let i = idxes[d];
      if (i === null || i === undefined) return null;
      i = i - dims[d].lo;
      lin = lin * size + i;
    }
    return lin;
  }

  function indexLabel(node, lin) {
    const dims = node.dimsInfo || [];
    if (!dims.length) return '[' + lin + ']';
    const parts = new Array(dims.length);
    let rest = lin;
    for (let d = dims.length - 1; d >= 0; d--) {
      const size = dims[d].hi - dims[d].lo + 1;
      parts[d] = dims[d].lo + (rest % size);
      rest = Math.floor(rest / size);
    }
    return '[' + parts.join(',') + ']';
  }

  function walkLeaves(node, baseBits, pathPrefix, cb, depth) {
    depth = depth || 0;
    if (depth > 40) return;
    if (node.kind === 'elem' || node.kind === 'string' || node.kind === 'unknown') {
      cb(node, baseBits, pathPrefix);
      return;
    }
    if (node.kind === 'struct' || node.kind === 'group') {
      for (const c of node.children || []) {
        walkLeaves(c, baseBits + (c.relBits || 0),
          pathPrefix ? pathPrefix + '.' + c.name : c.name, cb, depth + 1);
      }
      return;
    }
    if (node.kind === 'array') {
      const stride = node.elemBits === 1 ? 1 : (node.strideBits || 0);
      for (let i = 0; i < node.count; i++) {
        const label = indexLabel(node, i);
        const name = (pathPrefix || node.name) + label;
        walkLeaves(node.elem, baseBits + i * stride, name, cb, depth + 1);
      }
    }
  }

  /* ------------------------------------------------------------ 值 编码/解码 */
  function readU16(buf, b) { return (buf[b] << 8) | buf[b + 1]; }
  function readI16(buf, b) { const v = readU16(buf, b); return v & 0x8000 ? v - 0x10000 : v; }
  function readU32(buf, b) { return ((buf[b] << 24) >>> 0) + (buf[b + 1] << 16) + (buf[b + 2] << 8) + buf[b + 3]; }
  function readI32(buf, b) { return readU32(buf, b) | 0; }

  function readF32(buf, b) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return dv.getFloat32(b, false);
  }
  function readF64(buf, b) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return dv.getFloat64(b, false);
  }
  function readU64(buf, b) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return dv.getBigUint64(b, false);
  }
  function readI64(buf, b) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return dv.getBigInt64(b, false);
  }

  function fmtTime(ms) {
    const neg = ms < 0;
    ms = Math.abs(ms);
    const d = Math.floor(ms / 86400000); ms %= 86400000;
    const h = Math.floor(ms / 3600000); ms %= 3600000;
    const m = Math.floor(ms / 60000); ms %= 60000;
    const s = Math.floor(ms / 1000); ms %= 1000;
    let out = 'T#';
    if (d) out += d + 'd';
    if (h) out += h + 'h';
    if (m) out += m + 'm';
    if (s) out += s + 's';
    if (ms) out += ms + 'ms';
    if (out === 'T#') out = 'T#0ms';
    return (neg ? '-' : '') + out;
  }

  function fmtDate(days) {
    const d = new Date(Date.UTC(1990, 0, 1) + days * 86400000);
    return 'D#' + d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function fmtTod(ms) {
    ms = ms % 86400000;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms % 3600000 / 60000);
    const s = Math.floor(ms % 60000 / 1000);
    const mm = ms % 1000;
    return 'TOD#' + pad2(h) + ':' + pad2(m) + ':' + pad2(s) + '.' + String(mm).padStart(3, '0');
  }

  function fmtS5Time(buf, b) {
    const v = readU16(buf, b);
    const tb = (v >> 12) & 0x3; // 0=10ms 1=100ms 2=1s 3=10s
    const t = (v >> 12) & 0x3;
    const bcdVal = ((v >> 8) & 0xF) * 100 + ((v >> 4) & 0xF) * 10 + (v & 0xF);
    const base = [10, 100, 1000, 10000][tb];
    return 'S5T#' + (bcdVal * base) + 'ms';
  }

  function decodeDT(buf, b) {
    const yy = bcd(buf[b]), mo = bcd(buf[b + 1]), dd = bcd(buf[b + 2]);
    const hh = bcd(buf[b + 3]), mi = bcd(buf[b + 4]), ss = bcd(buf[b + 5]);
    const ms = bcd(buf[b + 6]) * 10 + ((buf[b + 7] >> 4) & 0x0F);
    return 'DT#' + (yy < 90 ? 2000 + yy : 1900 + yy) + '-' + pad2(mo) + '-' + pad2(dd) + ' ' +
      pad2(hh) + ':' + pad2(mi) + ':' + pad2(ss) + '.' + String(ms).padStart(3, '0');
  }

  function decodeDTL(buf, b) {
    const year = readU16(buf, b);
    const mo = buf[b + 2], dd = buf[b + 3], hh = buf[b + 5], mi = buf[b + 6], ss = buf[b + 7];
    const ns = readU32(buf, b + 8);
    return year + '-' + pad2(mo) + '-' + pad2(dd) + ' ' + pad2(hh) + ':' + pad2(mi) + ':' + pad2(ss) + '.' + String(ns).padStart(9, '0');
  }

  function decodeString(buf, b, len, wide) {
    if (wide) {
      const max = readU16(buf, b), act = Math.min(readU16(buf, b + 2), len);
      const bytes = new Uint8Array(act * 2);
      for (let i = 0; i < act * 2; i++) bytes[i] = buf[b + 4 + i];
      try { return new TextDecoder('utf-16be').decode(bytes); } catch (e) { return '?'; }
    }
    const max = buf[b], act = Math.min(buf[b + 1], len);
    const bytes = buf.subarray(b + 2, b + 2 + act);
    if (!act) return '';
    // S7 字符串常见 ASCII / CP936(GBK) / UTF-8，按最常见顺序尝试
    try {
      const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return utf8;
    } catch (e) { /* next */ }
    try { return new TextDecoder('gbk').decode(bytes); } catch (e) { return '?'; }
  }

  function hex2(v, width) {
    return '0x' + v.toString(16).toUpperCase().padStart(width || 2, '0');
  }

  function decodeLeaf(node, buf, bitPos) {
    const key = node.elemKey;
    const b = Math.floor(bitPos / 8);
    const bit = bitPos % 8;
    switch (key) {
      case 'bool': return ((buf[b] >> bit) & 1) ? 'TRUE' : 'FALSE';
      case 'byte': case 'usint': return String(buf[b]) + '  ' + hex2(buf[b]);
      case 'sint': return String((buf[b] << 24) >> 24);
      case 'char': { const c = buf[b]; return (c >= 32 && c < 127) ? "'" + String.fromCharCode(c) + "'" : hex2(c); }
      case 'wchar': { const c = readU16(buf, b); return (c >= 32 && c < 0xFFFF) ? "'" + String.fromCharCode(c) + "'" : hex2(c, 4); }
      case 'word': return String(readU16(buf, b)) + '  ' + hex2(readU16(buf, b), 4);
      case 'uint': return String(readU16(buf, b));
      case 'int': return String(readI16(buf, b));
      case 'dword': return String(readU32(buf, b)) + '  ' + hex2(readU32(buf, b), 8);
      case 'udint': return String(readU32(buf, b));
      case 'dint': return String(readI32(buf, b));
      case 'real': return String(round(readF32(buf, b), 7));
      case 'lreal': return String(readF64(buf, b));
      case 'lword': return '0x' + readU64(buf, b).toString(16).toUpperCase().padStart(16, '0');
      case 'ulint': return readU64(buf, b).toString();
      case 'lint': return readI64(buf, b).toString();
      case 'time': return fmtTime(readI32(buf, b));
      case 'ltime': return String(readI64(buf, b)) + 'ns';
      case 's5time': return fmtS5Time(buf, b);
      case 'date': return fmtDate(readU16(buf, b));
      case 'tod': return fmtTod(readU32(buf, b));
      case 'dt': return decodeDT(buf, b);
      case 'dtl': return decodeDTL(buf, b);
      case 'string': return decodeString(buf, b, node.strLen, false);
      case 'wstring': return decodeString(buf, b, node.strLen, true);
      case 'pointer': case 'any':
        return Array.from(buf.subarray(b, b + (key === 'any' ? 10 : 6))).map((x) => x.toString(16).padStart(2, '0')).join(' ');
      default:
        return Array.from(buf.subarray(b, b + 2)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    }
  }

  function round(v, digits) {
    if (!isFinite(v)) return v;
    const p = Math.pow(10, digits);
    return Math.round(v * p) / p;
  }

  /* ------------------------------------------------------ 字面量 -> 字节写入 */
  function parseLiteral(raw, node) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (!s) return null;
    // 去掉外层括号
    while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();

    const key = node.elemKey || (node.kind === 'string' ? (node.isWide ? 'wstring' : 'string') : null);

    if (key === 'bool') {
      const v = lower(s);
      if (v === 'true' || v === '1' || v === '16#1') return true;
      if (v === 'false' || v === '0' || v === '16#0') return false;
      const n = parseInt(s, 10);
      return isNaN(n) ? null : n !== 0;
    }
    if (key === 'string' || key === 'wstring') {
      const m = /^'(.*)'$/s.exec(s);
      return m ? m[1] : s.replace(/^'|'$/g, '');
    }
    if (key === 'char' || key === 'wchar') {
      const m = /^'(.*)'$/s.exec(s);
      return m ? m[1].charCodeAt(0) : null;
    }
    if (key === 'real' || key === 'lreal') {
      const n = parseNumber(s);
      return isFinite(n) ? n : null;
    }
    if (key === 'time' || key === 'ltime') return parseTimeMs(s);
    if (key === 's5time') return parseS5TimeMs(s);
    if (key === 'date') return parseDateDays(s);
    if (key === 'tod') return parseTodMs(s);
    if (key === 'dt' || key === 'dtl') return null; // 交给原文显示
    const n = parseNumber(s);
    return isFinite(n) ? n : null;
  }

  function parseNumber(s) {
    s = s.trim();
    let m;
    if ((m = /^([A-Z]{1,2})?#(\d+)#([0-9A-Fa-f]+)$/i.exec(s))) return parseInt(m[3], parseInt(m[2], 10));
    if ((m = /^16#([0-9A-Fa-f]+)$/i.exec(s))) return parseInt(m[1], 16);
    if ((m = /^2#([01]+)$/.exec(s))) return parseInt(m[1], 2);
    if ((m = /^8#([0-7]+)$/.exec(s))) return parseInt(m[1], 8);
    if ((m = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.exec(s))) return parseFloat(s);
    if (lower(s) === 'true') return 1;
    if (lower(s) === 'false') return 0;
    return NaN;
  }

  function parseTimeMs(s) {
    s = s.replace(/^(LT|T|TIME|LTIME)#/i, '');
    let total = 0;
    const re = /([+-]?\d+(?:\.\d+)?)(d|h|m|s|ms|us|ns)/gi;
    let m, found = false;
    while ((m = re.exec(s))) {
      found = true;
      const v = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const mult = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 }[unit] || 1;
      total += v * mult;
    }
    if (!found && /^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    return found ? total : null;
  }

  function parseS5TimeMs(s) {
    s = s.replace(/^S5T#/i, '');
    const ms = parseTimeMs(s);
    return ms;
  }

  function parseDateDays(s) {
    const m = /D#(\d{4})-(\d{1,2})-(\d{1,2})/i.exec(s);
    if (!m) return null;
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Math.round((d - Date.UTC(1990, 0, 1)) / 86400000);
  }

  function parseTodMs(s) {
    const m = /(?:TOD|TIME_OF_DAY)#(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?/i.exec(s);
    if (!m) return null;
    return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (m[4] ? +m[4].padStart(3, '0') : 0);
  }

  function writeLeaf(buf, node, bitPos, value) {
    if (value === null || value === undefined) return false;
    const key = node.elemKey;
    const b = Math.floor(bitPos / 8);
    const bit = bitPos % 8;
    const need = Math.ceil((bit + (ELEM[key] ? ELEM[key].bits : 16)) / 8);
    if (b + need > buf.length) return false;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
      switch (key) {
        case 'bool': if (value) buf[b] |= (1 << bit); else buf[b] &= ~(1 << bit); return true;
        case 'byte': case 'usint': buf[b] = value & 0xFF; return true;
        case 'sint': buf[b] = value & 0xFF; return true;
        case 'char': buf[b] = (typeof value === 'number' ? value : 0) & 0xFF; return true;
        case 'wchar': dv.setUint16(b, (typeof value === 'number' ? value : 0) & 0xFFFF); return true;
        case 'word': case 'uint': dv.setUint16(b, value & 0xFFFF); return true;
        case 'int': dv.setInt16(b, value); return true;
        case 'dword': case 'udint': dv.setUint32(b, value >>> 0); return true;
        case 'dint': dv.setInt32(b, value | 0); return true;
        case 'real': dv.setFloat32(b, value); return true;
        case 'lreal': dv.setFloat64(b, value); return true;
        case 'lword': case 'ulint': dv.setBigUint64(b, BigInt(Math.trunc(value))); return true;
        case 'lint': dv.setBigInt64(b, BigInt(Math.trunc(value))); return true;
        case 'time': dv.setInt32(b, value); return true;
        case 'ltime': dv.setBigInt64(b, BigInt(Math.trunc(value))); return true;
        case 's5time': dv.setUint16(b, encodeS5Time(value)); return true;
        case 'date': dv.setUint16(b, value & 0xFFFF); return true;
        case 'tod': dv.setUint32(b, value >>> 0); return true;
        case 'dt': writeDT(buf, b, value); return true;
        case 'dtl': return false;
        case 'string': {
          // value 已解析成字符串
          const s = String(value);
          if (node.strLen <= 0) return false;
          buf[b] = node.strLen;
          const enc = encodeS7String(s);
          buf[b + 1] = Math.min(enc.length, node.strLen);
          for (let i = 0; i < Math.min(enc.length, node.strLen); i++) buf[b + 2 + i] = enc[i];
          return true;
        }
        case 'wstring': {
          const s = String(value);
          const maxW = node.strLen;
          dv.setUint16(b, maxW);
          dv.setUint16(b + 2, Math.min(s.length, maxW));
          for (let i = 0; i < Math.min(s.length, maxW); i++) dv.setUint16(b + 4 + i * 2, s.charCodeAt(i));
          return true;
        }
        default: return false;
      }
    } catch (e) { return false; }
  }

  function encodeS7String(s) {
    // 优先 UTF-8；纯 ASCII 时两者一致
    const out = [];
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) { out.push(0xC0 | (code >> 6), 0x80 | (code & 63)); }
      else if (code < 0x10000) { out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); }
      else { out.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); }
    }
    return out;
  }

  function encodeS5Time(ms) {
    const bases = [10, 100, 1000, 10000];
    let bi = 0;
    while (bi < 3 && ms / bases[bi] > 999) bi++;
    const val = Math.min(999, Math.round(ms / bases[bi]));
    const bcdVal = ((Math.floor(val / 100) & 0xF) << 8) | ((Math.floor(val / 10) % 10) << 4) | (val % 10);
    return (bi << 12) | bcdVal;
  }

  function writeDT(buf, b, ms) { /* 暂不支持编码 DT 字面量 */ }

  /* ------------------------------------------------------------- 组 装结果 */
  function buildMemoryImage(block, opts) {
    const buf = new Uint8Array(Math.max(1, block.sizeBytes));
    const applied = { decl: 0, begin: 0, failed: [] };

    // 1) 声明里的初值（含嵌套结构 / UDT 成员的默认值）
    for (const node of block.children) applyDeclInit(node, node.offsetBits || 0, buf, applied);

    // 2) BEGIN 段赋值覆盖
    for (const asg of block.beginAssignments) {
      const target = resolveAssignPath(block, asg.path);
      if (!target) {
        applied.failed.push(asg.raw + '  (无法定位目标)');
        continue;
      }
      const val = parseLiteral(asg.raw, target.node);
      if (val === null) { applied.failed.push(asg.raw); continue; }
      if (writeLeaf(buf, target.node, target.bitOffset, val)) applied.begin++;
      else applied.failed.push(asg.raw);
    }
    return { buffer: buf, applied };
  }

  function applyDeclInit(node, baseBits, buf, applied) {
    const hasInit = node.init && node.init.length;

    if (node.kind === 'elem' || node.kind === 'string' || node.kind === 'unknown') {
      if (!hasInit) return;
      const val = parseLiteral(node.init[0], node);
      if (val !== null && writeLeaf(buf, node, baseBits, val)) applied.decl++;
      return;
    }

    if (node.kind === 'struct' || node.kind === 'group') {
      if (hasInit) {
        // 结构体的初值列表按叶子顺序平铺
        const leaves = [];
        walkLeaves(node, baseBits, '', (n, off) => leaves.push({ n: n, off: off }));
        node.init.forEach((raw, i) => {
          if (i >= leaves.length) return;
          const val = parseLiteral(raw, leaves[i].n);
          if (val !== null && writeLeaf(buf, leaves[i].n, leaves[i].off, val)) applied.decl++;
        });
      }
      for (const c of node.children || []) {
        applyDeclInit(c, baseBits + (c.relBits || 0), buf, applied);
      }
      return;
    }

    if (node.kind === 'array') {
      const stride = node.elemBits === 1 ? 1 : (node.strideBits || 0);
      if (hasInit) {
        if (node.elem.kind === 'struct' || node.elem.kind === 'group') {
          const leaves = [];
          walkLeaves(node, baseBits, '', (n, off) => leaves.push({ n: n, off: off }));
          node.init.forEach((raw, i) => {
            if (i >= leaves.length) return;
            const val = parseLiteral(raw, leaves[i].n);
            if (val !== null && writeLeaf(buf, leaves[i].n, leaves[i].off, val)) applied.decl++;
          });
        } else {
          node.init.forEach((raw, i) => {
            if (i >= node.count) return;
            const val = parseLiteral(raw, node.elem);
            if (val !== null && writeLeaf(buf, node.elem, baseBits + i * stride, val)) applied.decl++;
          });
        }
      }
      // 元素类型自带的默认值（UDT 成员的初值）
      if (node.elem.kind === 'struct' || node.elem.kind === 'group' || node.elem.init) {
        for (let i = 0; i < node.count; i++) {
          applyDeclInit(node.elem, baseBits + i * stride, buf, applied);
        }
      }
    }
  }

  function resolveAssignPath(block, path) {
    if (!path || !path.length) return null;
    let segs = path;
    // 去掉与块同名的首段
    if (segs.length > 1 && (lower(segs[0].name) === lower(block.name) ||
        segs[0].name.toUpperCase() === ('DB' + block.dbNumber))) segs = segs.slice(1);

    let acc = 0;          // 当前节点在块内的绝对位偏移
    let list = block.children;
    let node = null;

    for (const seg of segs) {
      let found = null;
      for (const n of list) {
        if (lower(n.name) === lower(seg.name)) { found = n; break; }
      }
      if (!found) return null;

      if (found.kind === 'array' && seg.indexes && seg.indexes.length) {
        const lin = arrayLinearIndex(found, seg.indexes);
        if (lin === null || lin < 0 || lin >= found.count) return null;
        const stride = found.elemBits === 1 ? 1 : (found.strideBits || 0);
        acc += (found.relBits || 0) + lin * stride;
        node = found.elem;
        list = (node.kind === 'struct' || node.kind === 'group') ? (node.children || []) : [];
      } else {
        acc += (found.relBits || 0);
        node = found;
        list = (found.kind === 'struct' || found.kind === 'group') ? (found.children || []) : [];
      }
    }
    if (!node) return null;
    if (node.kind !== 'elem' && node.kind !== 'string' && node.kind !== 'unknown') return null;
    return { node, bitOffset: acc };
  }

  /* --------------------------------------------------------------- 主入口 */
  function parse(text, options) {
    options = options || {};
    const split = splitComments(text);
    const p = new Parser(split.code, split.comments);
    p.codeLines = split.lines;
    let res = p.parseFile();

    // 合并外部提供的 UDT
    const udts = Object.assign({}, res.udts);
    if (options.udts) {
      for (const k of Object.keys(options.udts)) udts[lower(k)] = options.udts[k];
    }

    for (const block of res.blocks) {
      resolveRefs(block.children, udts, res.warnings, []);
    }

    for (const block of res.blocks) {
      buildLayout(block, { maxAlign: options.maxAlign || 4, packed: options.packed });
      block.image = buildMemoryImage(block, options);
      block.sizeBytes = block.sizeBytes;
    }

    return {
      blocks: res.blocks,
      udts,
      warnings: res.warnings,
      sourceText: text
    };
  }

  /* ------------------------------------------------------------ 行 级 检测 */
  function sniff(text) {
    const head = text.slice(0, 4096);
    let weird = 0;
    for (let i = 0; i < head.length; i++) {
      const c = head.charCodeAt(i);
      if (c === 0) weird += 10;
      else if (c < 9 || (c > 13 && c < 32)) weird++;
    }
    if (weird > 20) return 'binary';
    if (/DATA_BLOCK|FUNCTION_BLOCK|TYPE\s+"?UDT|STRUCT/i.test(head)) return 'source';
    return 'unknown';
  }

  /* --------------------------------------------------------------- 导出 */
  const api = {
    parse, sniff, splitComments, tokenize,
    ELEM, ALIAS, TYPE_LABEL,
    walkLeaves, decodeLeaf, parseLiteral, resolveAssignPath,
    arrayElemOffsetBits, arrayLinearIndex, indexLabel,
    fmtTime, fmtDate, fmtTod, decodeDT, decodeDTL, decodeString,
    cloneNode, buildLayout, buildMemoryImage, resolveRefs,
    _internal: { evalInt, parseNumber, parseTimeMs, parsePathTokens }
  };

  root.DBParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
