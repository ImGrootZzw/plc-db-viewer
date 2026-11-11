/* =========================================================================
 * app.js — 界面逻辑
 * ========================================================================= */
(function () {
  'use strict';

  const P = window.DBParse;
  const $ = (id) => document.getElementById(id);

  const el = {
    fileList: $('fileList'), fileEmpty: $('fileEmpty'), fileInput: $('fileInput'),
    openBtn: $('openBtn'), sampleBtn: $('sampleBtn'), printBtn: $('printBtn'),
    emptyState: $('emptyState'), doc: $('doc'), dropZone: $('dropZone'),
    titleBlock: $('titleBlock'), mapStrip: $('mapStrip'), mapRuler: $('mapRuler'),
    mapNote: $('mapNote'), mapCursor: $('mapCursor'), mapLegend: $('mapLegend'),
    tabs: $('tabs'), search: $('search'), varBody: $('varBody'), varTable: $('varTable'),
    panelVars: $('panelVars'), panelMem: $('panelMem'), panelStats: $('panelStats'),
    hexWrap: $('hexWrap'), statsBody: $('statsBody'),
    expandBtn: $('expandBtn'), collapseBtn: $('collapseBtn'), csvBtn: $('csvBtn'),
    warnBlock: $('warnBlock'), warnList: $('warnList'), warnCount: $('warnCount'),
    settingsBlock: $('settingsBlock'), alignSelect: $('alignSelect'), alignHint: $('alignHint'),
    toast: $('toast'), workspace: $('workspace')
  };

  const state = {
    files: [],
    blocks: [],
    activeKey: null,
    expanded: new Set(),
    search: '',
    tab: 'vars',
    selected: null,
    align: 4,
    rows: []
  };

  const CAT_LABEL = { bool: 'Bool', int: '整数', real: '浮点', str: '字符 / 字符串', time: '时间日期', struct: '结构', misc: '其它' };

  /* --------------------------------------------------------------- 工具 */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function bytes(n) { return n + ' B'; }
  function bitsLabel(node) {
    if (node.kind === 'elem' && node.elemKey === 'bool') return '1 bit';
    const b = node._sz ? node._sz.bits : 0;
    if (b % 8 === 0) return (b / 8) + ' B';
    return b + ' bit';
  }
  function bitLen(node) { return node._sz ? node._sz.bits : 0; }
  function offsetText(offBits) {
    const b = Math.floor(offBits / 8), bit = offBits % 8;
    return { byte: b, bit: bit, text: bit ? ('+' + b + '<span class="bit">.' + bit + '</span>') : ('+' + b) };
  }
  function dimsText(node) {
    if (!node.dims) return '';
    return node.dims.map((d) => (d.lo || []).join(' ') + '..' + (d.hi || []).join(' ')).join(',');
  }
  function typeLabel(node) {
    if (node.kind === 'array') {
      const e = node.elem ? typeLabel(node.elem) : '';
      return 'Array[' + dimsText(node) + ']' + (e ? ' of ' + e : '');
    }
    if (node.kind === 'struct') return node.typeName || 'Struct';
    return node.typeName || '';
  }
  function s7Address(block, node, offBits) {
    const db = block.dbNumber !== null ? 'DB' + block.dbNumber : 'DB?';
    const b = Math.floor(offBits / 8), bit = offBits % 8;
    if (node.kind === 'elem') {
      const t = P.ELEM[node.elemKey];
      if (!t) return db + '.DBB' + b;
      if (node.elemKey === 'bool') return db + '.DBX' + b + '.' + bit;
      if (t.bits === 8) return db + '.DBB' + b;
      if (t.bits === 16) return db + '.DBW' + b;
      if (t.bits === 32) return db + '.DBD' + b;
    }
    const n = Math.max(1, Math.ceil(bitLen(node) / 8));
    return db + '.DBB' + b + (n > 1 ? '..' + (b + n - 1) : '');
  }

  function catOf(node) {    if (!node) return 'misc';
    if (node.kind === 'array') return catOf(node.elem);
    if (node.kind === 'struct' || node.kind === 'group') return 'struct';
    if (node.kind === 'string') return 'str';
    const t = P.ELEM[node.elemKey];
    if (!t) return 'misc';
    if (t.cat === 'char') return 'str';
    return t.cat;
  }
  function isGroup(node) {
    return node.kind === 'struct' || node.kind === 'group' || node.kind === 'array';
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  const pathKey = (path) => (state.activeKey || '') + '|' + path;

  function activeEntry() {
    return state.blocks.find((b) => b.key === state.activeKey) || null;
  }

  /* ------------------------------------------------------------- 文件读取 */
  async function readText(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return new TextDecoder('utf-8').decode(buf); }
    }
  }

  async function addFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    let added = 0;
    for (const f of files) {
      if (!/\.(db|udt|scl|txt)$/i.test(f.name)) { toast('已跳过不支持的文件：' + f.name); continue; }
      const text = await readText(f);
      state.files.push({
        id: 'f' + (++uid),
        name: f.name,
        size: f.size,
        text: text,
        result: null,
        blocks: [],
        binary: false,
        error: ''
      });
      added++;
    }
    if (added) {
      parseAll();
      toast('已加载 ' + added + ' 个文件');
    }
  }
  let uid = 0;

  function parseAll() {
    // 第一遍：收集 UDT
    const udts = {};
    for (const f of state.files) {
      try {
        const r = P.parse(f.text, {});
        Object.assign(udts, r.udts || {});
      } catch (e) { /* 第二遍会记录错误 */ }
    }
    for (const f of state.files) {
      f.blocks = [];
      f.error = '';
      f.binary = P.sniff(f.text) === 'binary';
      try {
        const r = P.parse(f.text, { udts: udts, maxAlign: state.align });
        f.result = r;
        f.blocks = r.blocks.map((b, i) => ({ file: f, block: b, key: f.id + '#' + i, fileIndex: i }));
      } catch (e) {
        f.error = e && e.message ? e.message : String(e);
        f.result = null;
      }
    }

    state.blocks = [];
    for (const f of state.files) for (const b of f.blocks) state.blocks.push(b);

    if (!state.blocks.length) {
      state.activeKey = null;
      renderFileList();
      renderEmptyWarning();
      return;
    }
    const still = state.blocks.find((b) => b.key === state.activeKey);
    state.activeKey = still ? still.key : state.blocks[0].key;
    state.expanded.clear();
    state.selected = null;
    renderAll();
  }

  /* ------------------------------------------------------------- 左侧列表 */
  function renderFileList() {
    el.fileList.innerHTML = '';
    el.fileEmpty.hidden = state.files.length > 0;
    for (const f of state.files) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'file-item' + (f.blocks.some((b) => b.key === state.activeKey) ? ' active' : '');
      const meta = f.binary ? '二进制' : (f.error ? '出错' : (f.blocks.length + ' 块'));
      btn.innerHTML = '<span class="fname" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
        '<span class="fmeta">' + meta + '</span>';
      btn.addEventListener('click', () => {
        if (f.blocks.length) selectBlock(f.blocks[0].key);
        else if (f.binary) toast('这是二进制块文件，需要先导出为源文件');
        else if (f.error) toast('解析失败：' + f.error);
        else toast('这个文件里没有数据块');
      });
      li.appendChild(btn);

      if (f.blocks.length > 1 || (f.blocks.length === 1)) {
        const ul = document.createElement('ul');
        ul.className = 'block-list';
        for (const b of f.blocks) {
          const bl = document.createElement('li');
          const bb = document.createElement('button');
          bb.className = 'block-item' + (b.key === state.activeKey ? ' active' : '');
          bb.innerHTML = '<span>' + esc(b.block.name) + '</span>' +
            '<span class="bnum">' + (b.block.dbNumber !== null ? 'DB' + b.block.dbNumber : '') +
            ' · ' + b.block.sizeBytes + ' B</span>';
          bb.addEventListener('click', () => selectBlock(b.key));
          bl.appendChild(bb);
          ul.appendChild(bl);
        }
        li.appendChild(ul);
      }
      if (f.binary || f.error) {
        const ul = document.createElement('ul');
        ul.className = 'block-list';
        const li2 = document.createElement('li');
        li2.className = 'tiny';
        li2.style.color = '#A3372E';
        li2.style.padding = '2px 10px 6px';
        li2.textContent = f.binary ? '二进制块：请从 TIA 生成源文件' : ('解析错误：' + f.error);
        ul.appendChild(li2);
        li.appendChild(ul);
      }
      el.fileList.appendChild(li);
    }
  }

  function renderEmptyWarning() {
    const bad = state.files.find((f) => f.binary);
    const looksXml = state.files.some((f) => /^\s*</.test(f.text || ''));
    const drop = el.dropZone;
    el.emptyState.hidden = false;
    el.doc.hidden = true;
    if (bad) {
      drop.innerHTML =
        '<h3>这是二进制块文件</h3>' +
        '<p>文件头看起来是 0x70 0x71 的编译块，不是文本源。<br>' +
        '在 TIA Portal 里右键块 → “生成源文件”，或在 STEP 7 里用“生成源文件”导出 .db 后再拖进来。</p>' +
        '<div class="cta"><button class="btn" id="dropSample">先看示例</button></div>';
      const s = $('dropSample');
      if (s) s.addEventListener('click', loadSample);
    } else if (looksXml) {
      drop.innerHTML =
        '<h3>这是 XML 格式的导出</h3>' +
        '<p>文件内容是 TIA 的 XML（SIMATIC SD），不是 SCL 文本源。<br>' +
        '请改用“生成源文件 / Generate source”导出 <code>.db</code> 文本，或者把 SCL 源文件直接拖进来。</p>' +
        '<div class="cta"><button class="btn" id="dropSample">先看示例</button></div>';
      const s = $('dropSample');
      if (s) s.addEventListener('click', loadSample);
    } else if (state.files.length) {
      drop.innerHTML =
        '<h3>没有找到数据块</h3>' +
        '<p>文件读进来了，但里面没有 <code>DATA_BLOCK</code> 段。<br>也可能是 UDT 文件——单独上传它能帮助解析引用它的 DB。</p>' +
        '<div class="cta"><button class="btn" id="dropSample">看示例</button></div>';
      const s = $('dropSample');
      if (s) s.addEventListener('click', loadSample);
    }
  }

  /* --------------------------------------------------------------- 选中块 */
  function selectBlock(key) {
    state.activeKey = key;
    state.selected = null;
    state.expanded.clear();
    renderAll();
  }

  /* --------------------------------------------------------------- 总渲染 */
  function renderAll() {
    const entry = activeEntry();
    if (!entry) { renderFileList(); renderEmptyWarning(); return; }
    for (const b of state.blocks) if (!b.block._leaves) indexBlock(b.block);
    el.emptyState.hidden = true;
    el.doc.hidden = false;
    el.printBtn.disabled = false;
    el.settingsBlock.hidden = false;
    renderFileList();
    renderTitleBlock(entry.block);
    renderMap(entry.block);
    renderWarnings();
    renderTabs();
    renderVars();
    renderHex();
    renderStats();
    updateAlignUI();
  }

  function renderTitleBlock(block) {
    const app = block.image.applied;
    const leaves = block._leaves ? block._leaves.length : 0;
    const cells = [
      { l: '数据块', v: block.name, sans: true },
      { l: '块号', v: block.dbNumber !== null ? 'DB' + block.dbNumber : '—' },
      { l: '访问方式', v: block.optimized ? '优化' : '非优化', flag: !block.optimized },
      { l: '长度', v: String(block.sizeBytes), unit: '字节' },
      { l: '顶层成员', v: String(block.children.length) },
      { l: '叶子变量', v: String(leaves) },
      { l: '对齐上限', v: state.align === 'packed' ? '紧凑' : String(state.align), unit: state.align === 'packed' ? '' : '字节' },
      { l: '起始值', v: String(app.decl + app.begin), unit: '条' }
    ];
    let html = cells.map((c) =>
      '<div class="tb-cell' + (c.flag ? ' flag' : '') + '">' +
      '<div class="lbl">' + esc(c.l) + '</div>' +
      '<div class="val' + (c.sans ? ' sans' : '') + '" title="' + esc(c.v) + '">' + esc(c.v) +
      (c.unit ? '<small>' + esc(c.unit) + '</small>' : '') + '</div></div>'
    ).join('');
    if (block.optimized) {
      html += '<div class="tb-cell est"><div class="lbl">偏移</div><div class="val">估算值</div></div>';
    }
    el.titleBlock.innerHTML = html;
  }

  /* ----------------------------------------------------------------- 地图 */
  const CAT_CLASS = { bool: 'cat-bool', int: 'cat-int', real: 'cat-real', str: 'cat-str', time: 'cat-time', struct: 'cat-struct', misc: 'cat-misc' };

  function buildBands(block) {
    const items = [];
    for (const c of block.children) {
      const start = Math.floor((c.relBits || 0) / 8);
      const end = Math.max(start + 1, Math.ceil(((c.relBits || 0) + bitLen(c)) / 8));
      if (end <= start) continue;
      items.push({ start: start, end: end, names: [c.name], cat: catOf(c), span: end - start });
    }
    items.sort((a, b) => a.start - b.start);
    const bands = [];
    for (const it of items) {
      const last = bands[bands.length - 1];
      if (last && it.start < last.end) {
        last.end = Math.max(last.end, it.end);
        last.names.push(it.name);
        if (it.span > last.span) { last.span = it.span; last.cat = it.cat; }
      } else {
        bands.push(it);
      }
    }
    return bands;
  }

  function renderMap(block) {
    if (!block.sizeBytes) { el.mapStrip.innerHTML = ''; el.mapRuler.innerHTML = ''; return; }
    const size = block.sizeBytes;
    const bands = buildBands(block);

    el.mapStrip.innerHTML = '<div class="map-cursor" id="mapCursor"></div>';
    for (const b of bands) {
      const left = (b.start / size) * 100;
      const width = Math.max(((b.end - b.start) / size) * 100, 0.35);
      const seg = document.createElement('div');
      seg.className = 'seg ' + (CAT_CLASS[b.cat] || 'cat-misc');
      seg.style.left = left + '%';
      seg.style.width = Math.max(width - 0.08, 0.2) + '%';
      seg.dataset.names = b.names.join('|');
      seg.dataset.start = b.start;
      seg.dataset.end = b.end;
      seg.title = b.names.join('、') + '\n+' + b.start + ' … +' + (b.end - 1) + '（' + (b.end - b.start) + ' 字节）';
      seg.addEventListener('mouseenter', () => {
        el.mapNote.textContent = b.names.slice(0, 3).join('、') + (b.names.length > 3 ? ' 等 ' + b.names.length + ' 项' : '') +
          ' · +' + b.start + ' · ' + (b.end - b.start) + ' B';
      });
      seg.addEventListener('mouseleave', () => {
        const sel = currentSelection();
        el.mapNote.textContent = sel ? sel.note : defaultMapNote(block);
      });
      seg.addEventListener('click', () => {
        const name = b.names[0];
        const row = state.rows.find((r) => r.path === name);
        if (row) selectRow(row.path, true);
      });
      el.mapStrip.appendChild(seg);
    }

    // 标尺
    const step = niceStep(size);
    let ruler = '';
    for (let b = 0; b <= size; b += step) {
      if (b > 0 && b + step > size) {
        // 末端刻度靠右对齐，避免文字溢出
        ruler += '<div class="tick end"><span>' + b + '</span></div>';
        break;
      }
      ruler += '<div class="tick" style="left:' + Math.min((b / size) * 100, 99) + '%"><span>' + b + '</span></div>';
    }
    if (size % step !== 0 && !ruler.includes('tick end')) {
      ruler += '<div class="tick end"><span>' + size + '</span></div>';
    }
    el.mapRuler.innerHTML = ruler;

    // 图例
    const used = new Set(bands.map((b) => b.cat));
    el.mapLegend.innerHTML = Array.from(used).map((c) =>
      '<span><i class="' + CAT_CLASS[c] + '"></i>' + CAT_LABEL[c] + '</span>').join('');

    el.mapNote.textContent = defaultMapNote(block);
    el.mapCursor = $('mapCursor');
    updateMapCursor();
  }

  function defaultMapNote(block) {
    return (block.optimized ? '优化访问块 · 偏移为估算 · ' : '非优化块 · ') + block.sizeBytes + ' 字节';
  }

  function niceStep(size) {
    const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
    for (const s of steps) {
      if (size / s <= 9) return s;
    }
    return Math.ceil(size / 9);
  }

  function updateMapCursor() {
    const entry = activeEntry();
    const strip = el.mapStrip.querySelector('.map-cursor');
    if (!entry || !strip) return;
    const row = state.rows.find((r) => r.path === state.selected);
    if (!row) { strip.style.display = 'none'; return; }
    const size = entry.block.sizeBytes;
    strip.style.display = 'block';
    strip.style.left = (Math.floor(row.offsetBits / 8) / size * 100) + '%';
    document.querySelectorAll('.seg.sel').forEach((s) => s.classList.remove('sel'));
    const seg = Array.from(el.mapStrip.querySelectorAll('.seg')).find((s) =>
      (s.dataset.names || '').split('|').includes(row.path.split('.')[0].split('[')[0]));
    if (seg) seg.classList.add('sel');
  }

  function currentSelection() {
    const entry = activeEntry();
    if (!entry || !state.selected) return null;
    const row = state.rows.find((r) => r.path === state.selected);
    if (!row) return null;
    const o = offsetText(row.offsetBits);
    return { row: row, note: row.path + ' · +' + o.byte + (o.bit ? '.' + o.bit : '') + ' · ' + bitsLabel(row.node) };
  }

  /* ----------------------------------------------------------------- 告警 */
  function renderWarnings() {
    const entry = activeEntry();
    if (!entry) return;
    const list = (entry.file.result && entry.file.result.warnings) || [];
    const blockWarn = entry.block.warnings || [];
    const all = list.concat(blockWarn);
    if (!all.length) { el.warnBlock.hidden = true; return; }
    el.warnBlock.hidden = false;
    el.warnCount.textContent = all.length;
    el.warnList.innerHTML = all.slice(0, 40).map((w) =>
      '<li>' + esc(w.message || w) + (w.line ? '<span class="ln">L' + w.line + '</span>' : '') + '</li>').join('');
    if (all.length > 40) {
      el.warnList.innerHTML += '<li>还有 ' + (all.length - 40) + ' 条…</li>';
    }
  }

  /* ------------------------------------------------------------------ 行 */
  function buildRows(block, expanded, query) {
    const rows = [];
    const buf = block.image.buffer;
    const search = (query || '').trim().toLowerCase();
    const match = (s) => !search || String(s).toLowerCase().indexOf(search) >= 0;

    function decodeAt(node, off) {
      try { return P.decodeLeaf(node, buf, off); } catch (e) { return '?'; }
    }

    function summary(node) {
      if (node.kind === 'array') {
        const n = node.count;
        const elb = bitLen(node.elem);
        const total = Math.ceil(bitLen(node) / 8);
        return n + ' 项 · ' + total + ' B';
      }
      if (node.kind === 'struct' || node.kind === 'group') {
        return (node.children ? node.children.length : 0) + ' 项 · ' + Math.ceil(bitLen(node) / 8) + ' B';
      }
      return '';
    }

    function walk(node, depth, path, off, name) {
      const group = isGroup(node);
      const row = {
        path: path,
        depth: depth,
        name: name,
        node: node,
        group: group,
        expanded: !!search || expanded.has(pathKey(path)),
        offsetBits: off,
        typeName: typeLabel(node),
        init: node.init && node.init.length ? node.init.join(', ') : '',
        comment: node.comment || '',
        value: group ? summary(node) : decodeAt(node, off),
        bits: bitLen(node)
      };
      rows.push(row);

      if (!group) return;
      if (search) {
        // 搜索模式下全部展开
      } else if (!row.expanded) {
        return;
      }

      if (node.kind === 'array') {
        const stride = (node.elem && node.elem._sz && node.elem._sz.bits === 1) ? 1 : (node.strideBits || 0);
        const cap = Math.min(node.count, 500);
        for (let i = 0; i < cap; i++) {
          const label = P.indexLabel(node, i);
          walk(node.elem, depth + 1, path + label, off + i * stride, label);
        }
        if (node.count > cap) {
          rows.push({ path: path + '::more', depth: depth + 1, more: true, text: '数组共 ' + node.count + ' 项，表格只显示前 ' + cap + ' 项（CSV 导出为全部）' });
        }
      } else {
        for (const c of node.children || []) {
          walk(c, depth + 1, path + '.' + c.name, off + (c.relBits || 0), c.name);
        }
      }
    }

    for (const c of block.children) walk(c, 0, c.name, c.relBits || 0, c.name);

    if (search) {
      // 只保留匹配的行及其祖先
      const keep = new Set();
      for (const r of rows) {
        if (r.more) continue;
        const hit = match(r.name) || match(r.path) || match(r.typeName) ||
          match(r.comment) || match(r.init) || match(String(r.value));
        if (!hit) continue;
        let p = r.path;
        while (p) {
          keep.add(p);
          if (p.endsWith(']')) p = p.replace(/\[[^\]]*\]$/, '');
          else {
            const i = p.lastIndexOf('.');
            if (i < 0) break;
            p = p.slice(0, i);
          }
        }
        keep.add(r.path);
      }
      return rows.filter((r) => (r.more ? false : keep.has(r.path)));
    }
    return rows;
  }

  function renderVars() {
    const entry = activeEntry();
    if (!entry) return;
    const block = entry.block;
    const rows = buildRows(block, state.expanded, state.search);
    state.rows = rows;

    if (!rows.length) {
      el.varBody.innerHTML = '<tr><td colspan="8" class="empty-note">没有匹配的变量</td></tr>';
      return;
    }

    const html = rows.map((r) => {
      if (r.more) {
        return '<tr class="more"><td colspan="8" style="padding-left:' + (14 + r.depth * 14) + 'px">' + esc(r.text) + '</td></tr>';
      }
      const o = offsetText(r.offsetBits);
      const sel = state.selected === r.path ? ' selected' : '';
      const rootCls = r.depth === 0 ? ' root' : '';
      const grpCls = r.group ? ' group' : '';
      const disc = r.group
        ? '<button class="row-disclosure' + (r.expanded ? ' open' : '') + '" data-toggle="' + esc(r.path) + '" aria-label="展开">' +
          '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 1l4 3-4 3z" fill="currentColor"/></svg></button>'
        : '<span class="leaf-dot"><i></i></span>';
      let vcls = 'val';
      if (/^TRUE$/.test(String(r.value))) vcls += ' true';
      else if (/^FALSE$/.test(String(r.value))) vcls += ' false';
      else if (r.node.kind === 'string' || (r.node.kind === 'elem' && (r.node.elemKey === 'string' || r.node.elemKey === 'wstring'))) vcls += ' str';

      const offsetCell = '<td class="num off" title="S7 地址 ' + esc(s7Address(block, r.node, r.offsetBits)) + '">' +
        '<span class="' + (block.optimized ? 'est' : '') + '">' + o.text + '</span></td>';

      return '<tr class="' + (rootCls + grpCls + sel).trim() + '" data-path="' + esc(r.path) + '">' +
        '<td><div class="name-cell" style="padding-left:' + (r.depth * 14) + 'px">' + disc +
        '<span class="nm" title="' + esc(r.path) + '">' + esc(r.name) + '</span></div></td>' +
        '<td class="typename' + (r.node.kind === 'unknown' ? ' ref' : '') + '" title="' + esc(r.typeName) + '">' + esc(r.typeName) + '</td>' +
        offsetCell +
        '<td class="num">' + (r.node.kind === 'elem' && r.node.elemKey === 'bool' ? (r.offsetBits % 8) : '') + '</td>' +
        '<td class="num">' + bitsLabel(r.node) + '</td>' +
        '<td class="init" title="' + esc(r.init) + '">' + (r.init ? esc(r.init) : '<span style="color:#B9C4C0">—</span>') + '</td>' +
        '<td class="' + vcls + '" title="' + esc(r.value) + '">' + esc(r.value) + '</td>' +
        '<td class="comment" title="' + esc(r.comment) + '">' + esc(r.comment) + '</td>' +
        '</tr>';
    }).join('');

    el.varBody.innerHTML = html;
    updateMapCursor();
  }

  /* --------------------------------------------------------------- 选择/交互 */
  function selectRow(path, fromMap) {
    state.selected = state.selected === path ? null : path;
    document.querySelectorAll('#varBody tr.selected').forEach((tr) => tr.classList.remove('selected'));
    if (state.selected) {
      const tr = el.varBody.querySelector('tr[data-path="' + cssEscape(state.selected) + '"]');
      if (tr) {
        tr.classList.add('selected');
        if (!fromMap) tr.scrollIntoView({ block: 'nearest' });
      }
    }
    const sel = currentSelection();
    el.mapNote.textContent = sel ? sel.note : defaultMapNote(activeEntry().block);
    updateMapCursor();
    renderHex();
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/"/g, '\\"');
  }

  el.varBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (btn) {
      const path = btn.getAttribute('data-toggle');
      const key = pathKey(path);
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      renderVars();
      return;
    }
    const tr = e.target.closest('tr[data-path]');
    if (!tr) return;
    const path = tr.getAttribute('data-path');
    const row = state.rows.find((r) => r.path === path);
    if (row && row.group && !e.shiftKey) {
      // 点组行本身：展开/折叠
      const key = pathKey(path);
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      renderVars();
      const tr2 = el.varBody.querySelector('tr[data-path="' + cssEscape(path) + '"]');
      if (tr2) tr2.classList.add('selected');
    }
    selectRow(path);
  });

  /* ------------------------------------------------------------------ 搜索 */
  el.search.addEventListener('input', () => {
    state.search = el.search.value;
    renderVars();
  });

  /* ------------------------------------------------------------------ 标签 */
  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.tab = b.dataset.tab;
    renderTabs();
    if (state.tab === 'mem') renderHex();
  });

  function renderTabs() {
    el.tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
    el.panelVars.hidden = state.tab !== 'vars';
    el.panelMem.hidden = state.tab !== 'mem';
    el.panelStats.hidden = state.tab !== 'stats';
    el.search.style.visibility = state.tab === 'stats' ? 'hidden' : 'visible';
  }

  /* -------------------------------------------------------------------- hex */
  function renderHex() {
    if (state.tab !== 'mem') return;
    const entry = activeEntry();
    if (!entry) return;
    const block = entry.block;
    const buf = block.image.buffer;
    const total = block.sizeBytes;

    if (!total) { el.hexWrap.innerHTML = '<div class="empty-note">这个块没有数据区。</div>'; return; }

    const row = state.selected ? state.rows.find((r) => r.path === state.selected) : null;
    let selStart = -1, selEnd = -1;
    if (row) {
      selStart = Math.floor(row.offsetBits / 8);
      selEnd = Math.min(total, Math.ceil((row.offsetBits + Math.max(1, row.bits)) / 8));
    }

    const LIMIT = 16384;
    const shown = Math.min(total, LIMIT);
    let html = '<div class="hex-head"><span class="t">原始字节 · 起始值镜像</span>' +
      '<span class="n">' + (row ? esc(row.path) + ' → +' + selStart + ' … +' + (selEnd - 1) : '点击上面表格的变量可高亮字节范围') + '</span></div>';

    html += '<div class="hex">';
    for (let off = 0; off < shown; off += 16) {
      let bytesHtml = '';
      let ascii = '';
      for (let i = 0; i < 16; i++) {
        const p = off + i;
        if (p >= total) { bytesHtml += '   '; ascii += ' '; continue; }
        const v = buf[p];
        const hit = p >= selStart && p < selEnd;
        bytesHtml += '<b class="' + (hit ? 'hit' : '') + '">' + v.toString(16).toUpperCase().padStart(2, '0') + '</b>' + (i === 7 ? '  ' : ' ');
        const ch = v >= 32 && v < 127 ? String.fromCharCode(v) : '.';
        ascii += '<span class="' + (hit ? 'hit' : '') + '">' + (ch === '<' ? '&lt;' : ch === '&' ? '&amp;' : ch) + '</span>';
      }
      html += '<div class="ln" data-off="' + off + '"><span class="addr">' + off.toString(16).toUpperCase().padStart(4, '0') + '</span>' +
        '<span class="bytes">' + bytesHtml + '</span><span class="asc">' + ascii + '</span></div>';
    }
    html += '</div>';

    if (total > LIMIT) {
      html += '<div class="hex-note">块共 ' + total + ' 字节，此处显示前 ' + LIMIT + ' 字节。完整内容可导出 CSV 查看。</div>';
    }
    if (block.optimized) {
      html += '<div class="hex-note">注意：这是优化访问块（S7-1200/1500）。实际运行时 PLC 内部布局由编译器决定，' +
        '这里的字节排布是按声明顺序重建的起始值镜像，偏移不能用于绝对地址访问。</div>';
    }
    el.hexWrap.innerHTML = html;

    el.hexWrap.querySelectorAll('.ln').forEach((ln) => {
      ln.addEventListener('click', () => {
        const off = parseInt(ln.dataset.off, 10);
        for (let p = off; p < off + 16; p++) {
          const owner = block._byteOwner && block._byteOwner.get(p);
          if (owner !== undefined) { selectRow(owner); return; }
        }
      });
    });
  }

  /* ------------------------------------------------------------------ 统计 */
  function renderStats() {
    const entry = activeEntry();
    if (!entry) return;
    const block = entry.block;
    const leaves = block._leaves || [];

    const counts = { bool: 0, int: 0, real: 0, str: 0, time: 0, struct: 0, misc: 0 };
    for (const leaf of leaves) {
      const c = catOf(leaf.node);
      counts[c] = (counts[c] || 0) + 1;
    }

    let structs = 0, arrays = 0, arrayElems = 0, maxDepth = 0, unknown = 0, boolBits = 0;

    (function scan(nodes, depth) {
      for (const n of nodes) {
        maxDepth = Math.max(maxDepth, depth);
        if (n.kind === 'struct') { structs++; scan(n.children || [], depth + 1); }
        else if (n.kind === 'array') {
          arrays++;
          arrayElems += n.count;
          scan([n.elem], depth + 1);
        } else if (n.kind === 'unknown') unknown++;
      }
    })(block.children, 1);
    for (const leaf of leaves) if (leaf.node.elemKey === 'bool') boolBits++;

    const top = block.children.map((c) => ({
      name: c.name, bytes: Math.ceil(bitLen(c) / 8), cat: catOf(c)
    })).sort((a, b) => b.bytes - a.bytes);

    const maxTop = Math.max(1, ...top.map((t) => t.bytes));
    const totalCount = leaves.length || 1;

    const statCard =
      '<div class="stat-card"><h4>块概况</h4><dl class="stat-grid">' +
      row2('数据块', block.name) +
      row2('块号', block.dbNumber !== null ? 'DB' + block.dbNumber : '—') +
      row2('访问方式', block.optimized ? '优化（偏移为估算）' : '非优化') +
      row2('数据长度', block.sizeBytes + ' 字节') +
      row2('顶层成员', block.children.length) +
      row2('叶子变量', leaves.length) +
      row2('结构体 / 数组', structs + ' / ' + arrays) +
      row2('数组元素合计', arrayElems) +
      row2('Bool 位数', boolBits) +
      row2('最大嵌套深度', maxDepth) +
      row2('起始值条数', (block.image.applied.decl + block.image.applied.begin)) +
      (unknown ? row2('未识别类型', unknown) : '') +
      '</dl></div>';

    const catCard =
      '<div class="stat-card"><h4>变量类型分布</h4><div class="bars">' +
      Object.keys(counts).filter((k) => counts[k]).sort((a, b) => counts[b] - counts[a]).map((k) =>
        '<div class="bar-row"><span class="bname">' + CAT_LABEL[k] + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + (counts[k] / totalCount * 100) + '%"></span></span>' +
        '<span class="bval">' + counts[k] + '</span></div>').join('') +
      '</div></div>';

    const topCard =
      '<div class="stat-card"><h4>顶层成员占用</h4><div class="bars">' +
      top.slice(0, 10).map((t) =>
        '<div class="bar-row"><span class="bname" title="' + esc(t.name) + '">' + esc(t.name) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + (t.bytes / maxTop * 100) + '%"></span></span>' +
        '<span class="bval">' + t.bytes + ' B</span></div>').join('') +
      '</div>' + (top.length > 10 ? '<div class="tiny" style="margin-top:10px">另有 ' + (top.length - 10) + ' 个成员未列出</div>' : '') + '</div>';

    el.statsBody.innerHTML = statCard + catCard + topCard;
  }

  function row2(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'; }

  /* --------------------------------------------------------------- 展开按钮 */
  el.expandBtn.addEventListener('click', () => {
    const entry = activeEntry();
    if (!entry) return;
    let n = 0;
    (function scan(nodes, prefix) {
      for (const node of nodes) {
        if (isGroup(node)) {
          const p = prefix ? prefix + '.' + node.name : node.name;
          state.expanded.add(pathKey(p));
          n++;
          if (node.kind === 'array') {
            if (node.elem.kind === 'struct') scan([node.elem], p + '[1]');
          } else scan(node.children || [], p);
        }
      }
    })(entry.block.children, '');
    renderVars();
    if (n > 400) toast('已展开 ' + n + ' 个节点，表格较长');
  });

  el.collapseBtn.addEventListener('click', () => {
    state.expanded.clear();
    renderVars();
  });

  /* ------------------------------------------------------------------ CSV */
  function csvCell(v) {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  el.csvBtn.addEventListener('click', () => {
    const entry = activeEntry();
    if (!entry) return;
    const block = entry.block;
    const buf = block.image.buffer;
    const lines = [['名称', '类型', '字节偏移', '位', '长度(字节)', '起始值', '起始值镜像', '注释'].join(',')];
    let n = 0;
    const CAP = 50000;

    const walkBase = (node, off, path) => {
      if (n >= CAP) return;
      if (isGroup(node)) {
        if (node.kind === 'array') {
          const stride = (node.elem._sz && node.elem._sz.bits === 1) ? 1 : (node.strideBits || 0);
          for (let i = 0; i < node.count; i++) {
            if (n >= CAP) return;
            walkBase(node.elem, off + i * stride, path + P.indexLabel(node, i));
          }
        } else {
          for (const c of node.children || []) walkBase(c, off + (c.relBits || 0), path + '.' + c.name);
        }
        return;
      }
      n++;
      let val = '';
      try { val = P.decodeLeaf(node, buf, off); } catch (e) { val = '?'; }
      lines.push([path, node.typeName || '', Math.floor(off / 8), off % 8,
        Math.ceil(bitLen(node) / 8), (node.init || []).join(' '), val, node.comment || '']
        .map(csvCell).join(','));
    };

    for (const c of block.children) walkBase(c, c.relBits || 0, c.name);

    const csv = '﻿' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (block.name || 'DB') + '_variables.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast('已导出 ' + (lines.length - 1) + ' 行' + (n >= CAP ? '（已截断到 5 万行）' : ''));
  });

  /* --------------------------------------------------------------- 渲染辅助 */
  function indexBlock(block) {
    const leaves = [];
    const byteOwner = new Map();
    for (const c of block.children) {
      P.walkLeaves(c, c.relBits || 0, c.name, (node, off, path) => {
        leaves.push({ node: node, offsetBits: off, path: path });
        const start = Math.floor(off / 8);
        const end = Math.ceil((off + Math.max(1, bitLen(node))) / 8);
        for (let b = start; b < end; b++) if (!byteOwner.has(b)) byteOwner.set(b, path);
      });
    }
    block._leaves = leaves;
    block._byteOwner = byteOwner;
  }

  /* --------------------------------------------------------------- 样例 */
  const SAMPLES = [
    {
      name: 'DB_Pallet.db',
      text: [
        'DATA_BLOCK "DB_Pallet"',
        "{ S7_Optimized_Access := 'FALSE' }",
        'VERSION : 0.1',
        'NON_RETAIN',
        '   VAR',
        '      Ready : Bool;   // 就绪',
        '      Fault : Bool;   // 故障',
        '      Mode : Int := 2;   // 运行模式',
        '      Speed : Real := 12.5;   // 速度 m/min',
        "      Name : String[20] := 'Conveyor-01';   // 设备名",
        '      Count : DInt;   // 计数',
        '      Tags : Array[1..4] of Bool;',
        '      Temps : Array[0..2] of Real := 1.0, 2.0, 3.0;',
        '      Motor : Struct',
        '         Run : Bool;   // 运行中',
        '         Current : Real := 4.25;   // 电流 A',
        '         ErrCode : Word;',
        '      END_STRUCT;',
        '   END_VAR',
        'BEGIN',
        '   "DB_Pallet".Count := 100;',
        'END_DATA_BLOCK'
      ].join('\n')
    },
    {
      name: 'DB12_AGV.db',
      text: [
        'DATA_BLOCK DB 12',
        'TITLE =AGV station data',
        'VERSION : 0.1',
        '',
        '  STRUCT',
        '   Station : ARRAY [1..8] OF',
        '      STRUCT',
        '         Occupied : BOOL ;	(* 有货 *)',
        '         PalletNo : DINT ;	(* 托盘号 *)',
        '         Height : REAL ;	(* 高度 mm *)',
        '      END_STRUCT ;',
        '   Total : INT ;',
        '   UpdateTime : DATE_AND_TIME ;',
        '   Code : ARRAY [0..1, 1..3] OF INT ;',
        '  END_STRUCT ;',
        '',
        'BEGIN',
        '',
        'END_DATA_BLOCK'
      ].join('\n')
    },
    {
      name: 'UDT_Motor.udt',
      text: [
        'TYPE "UDT_Motor"',
        'VERSION : 0.1',
        '   STRUCT',
        '      Run : Bool;   // 运行中',
        '      Current : Real;   // 电流 A',
        '      ErrCode : Word;   // 故障码',
        '   END_STRUCT;',
        'END_TYPE'
      ].join('\n')
    },
    {
      name: 'DB_Line.db',
      text: [
        'DATA_BLOCK "DB_Line"',
        "{ S7_Optimized_Access := 'FALSE' }",
        'VERSION : 0.1',
        '   VAR',
        '      Motors : Array[1..3] of "UDT_Motor";   // 三台电机',
        '      Total : Int;   // 总数',
        '      StartTime : DTL;',
        '   END_VAR',
        'BEGIN',
        '   "DB_Line".Motors[2].Current := 6.5;',
        '   "DB_Line".Motors[1].Run := TRUE;',
        'END_DATA_BLOCK'
      ].join('\n')
    }
  ];

  function loadSample() {
    state.files = [];
    state.expanded.clear();
    for (const s of SAMPLES) {
      state.files.push({
        id: 'f' + (++uid), name: s.name, size: s.text.length, text: s.text,
        result: null, blocks: [], binary: false, error: ''
      });
    }
    parseAll();
    toast('示例已载入：4 个文件 / 4 个块');
  }

  /* --------------------------------------------------------------- 初始化 */
  /* 事件绑定 */
  el.openBtn.addEventListener('click', () => el.fileInput.click());
  const dropOpen = $('dropOpen');
  if (dropOpen) dropOpen.addEventListener('click', () => el.fileInput.click());
  const dropSample = $('dropSample');
  if (dropSample) dropSample.addEventListener('click', loadSample);
  el.sampleBtn.addEventListener('click', loadSample);
  el.fileInput.addEventListener('change', (e) => { addFiles(e.target.files); el.fileInput.value = ''; });
  el.printBtn.addEventListener('click', () => window.print());

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  el.alignSelect.addEventListener('click', (e) => {
    const b = e.target.closest('[data-align]');
    if (!b) return;
    const v = b.dataset.align;
    state.align = v === 'packed' ? 'packed' : parseInt(v, 10);
    if (state.files.length) {
      parseAll();
      toast('已按' + (v === 'packed' ? '紧凑' : v + ' 字节对齐') + '重新排布');
    }
    updateAlignUI();
  });

  function updateAlignUI() {
    const val = String(state.align);
    el.alignSelect.querySelectorAll('[data-align]').forEach((b) => {
      const on = b.dataset.align === val;
      b.style.background = on ? 'var(--accent)' : 'transparent';
      b.style.color = on ? '#fff' : 'var(--ink)';
      b.style.fontWeight = on ? '600' : '400';
    });
    el.alignHint.textContent = state.align === 'packed'
      ? '无填充，Bool 仍按位打包'
      : '结构体按最大成员对齐，上限 ' + state.align + ' 字节';
  }

  updateAlignUI();

  // 调试 / 自动化用：允许外部载入示例
  window.__dbLoadSample = loadSample;
  window.__dbSelect = selectBlock;
  window.__dbRenderVars = renderVars;
  window.__dbState = state;
})();
