/* 极简 DOM 桩：跑 app.js 的渲染路径，抓运行时错误 */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, on) { if (on === undefined) { this.s.has(c) ? this.s.delete(c) : this.s.add(c); } else { on ? this.s.add(c) : this.s.delete(c); } }
  contains(c) { return this.s.has(c); }
}
class El {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList();
    this._html = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.title = '';
    this.className = '';
    this.parentElement = null;
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  click() {}
  scrollIntoView() {}
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  focus() {}
}
const byId = new Map();
const document = {
  body: new El('body'),
  documentElement: new El('html'),
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, new El('div', id));
    return byId.get(id);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tag) { return new El(tag); },
  addEventListener() {},
  createTextNode(t) { return { textContent: t }; }
};
const window = {
  addEventListener() {},
  removeEventListener() {},
  document,
  setTimeout,
  clearTimeout,
  print() {},
  CSS: undefined
};

global.window = window;
global.document = document;
global.CSS = undefined;

const fs = require('fs');
require('../src/dbparse.js');
window.DBParse = global.DBParse;
require('../src/app.js');

if (!window.__dbLoadSample) { console.log('FAIL: __dbLoadSample 未注册'); process.exit(1); }

let failed = 0;
function run(label, fn) {
  try { fn(); console.log('✓', label); }
  catch (e) { failed++; console.log('✗', label, '\n   ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e); }
}

run('载入示例', () => window.__dbLoadSample());

const S = window.__dbState;
console.log('files:', S.files.length, 'blocks:', S.blocks.length, 'active:', S.activeKey);
for (const f of S.files) console.log('  ', f.name, '→', f.blocks.length, '块', f.error || '', f.binary ? '(binary)' : '');

function rows() {
  const body = byId.get('varBody').innerHTML;
  return (body.match(/<tr/g) || []).length;
}

for (const b of S.blocks) {
  run('渲染 ' + b.block.name, () => {
    window.__dbSelect(b.key);
    const html = byId.get('varBody').innerHTML;
    console.log('   ', b.block.name, b.block.sizeBytes + 'B', '行', rows(),
      '| 首行', (html.match(/data-path="([^"]+)"/) || [])[1]);
    if (/undefined|NaN/.test(html)) throw new Error('表格里出现 undefined/NaN');
    if (!/<tr/.test(html)) throw new Error('表格为空');
  });
}

run('搜索过滤', () => {
  window.__dbSelect(S.blocks[0].key);
  S.search = 'Temps';
  window.__dbRenderVars();
  const html = byId.get('varBody').innerHTML;
  if (!html.includes('Temps')) throw new Error('搜索结果为空');
  console.log('    命中行', (html.match(/<tr/g) || []).length);
});

run('统计/展开', () => {
  S.search = '';
  const html = byId.get('statsBody').innerHTML;
  if (!html.includes('块概况')) throw new Error('统计未渲染');
});

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
