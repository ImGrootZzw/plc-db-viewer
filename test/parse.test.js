const fs = require('fs');
const path = require('path');
const P = require('../src/dbparse.js');

const dir = path.join(__dirname, 'samples');
const files = fs.readdirSync(dir).filter((f) => /\.(db|udt)$/i.test(f));

// 先收集 UDT
const udts = {};
for (const f of files) {
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  const r = P.parse(txt, {});
  Object.assign(udts, r.udts);
}

let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`  ✗ ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  return ok;
}

for (const f of files) {
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  const r = P.parse(txt, { udts, maxAlign: 4 });
  console.log('\n=== ' + f + ' ===');
  if (r.warnings.length) console.log('warnings:', r.warnings.map((w) => w.message));
  for (const b of r.blocks) {
    console.log(`DB ${b.dbNumber || '-'} "${b.name}" optimized=${b.optimized} size=${b.sizeBytes}B align=${b.maxAlign} vars=${b.children.length}`);
    const rows = [];
    for (const c of b.children) {
      P.walkLeaves(c, c.relBits, c.name, (n, off, p) => {
        rows.push({ name: p, type: n.typeName, off, val: P.decodeLeaf(n, b.image.buffer, off) });
      });
    }
    for (const row of rows.slice(0, 40)) {
      const byte = Math.floor(row.off / 8);
      const bit = row.off % 8;
      console.log(`   +${byte}.${bit}`.padEnd(9) + String(row.type).padEnd(16) + String(row.name).padEnd(28) + ' = ' + row.val);
    }
    console.log('   image:', Array.from(b.image.buffer).map((x) => x.toString(16).padStart(2, '0')).join(' '));
    if (b.image.applied.failed.length) console.log('   init failed:', b.image.applied.failed);
  }
}

// ---- 断言 ----
console.log('\n=== assertions ===');
{
  const r = P.parse(fs.readFileSync(path.join(dir, 'DB_Pallet.db'), 'utf8'), {});
  const b = r.blocks[0];
  check('Pallet size', b.sizeBytes, 64);
  const map = {};
  for (const c of b.children) P.walkLeaves(c, c.relBits, c.name, (n, off, p) => { map[p] = off; });
  check('Ready', map['Ready'], 0);
  check('Fault', map['Fault'], 1);
  check('Mode', map['Mode'], 16);
  check('Speed', map['Speed'], 32);
  check('Name', map['Name'], 64);
  check('Count', map['Count'], 256);
  check('Tags[1]', map['Tags[1]'], 256 + 32);
  check('Tags[4]', map['Tags[4]'], 256 + 35);
  check('Temps[0]', map['Temps[0]'], 320);
  check('Temps[2]', map['Temps[2]'], 320 + 64);
  check('Motor.Run', map['Motor.Run'], 416);
  check('Motor.Current', map['Motor.Current'], 448);
  check('Motor.ErrCode', map['Motor.ErrCode'], 480);
  const read = (p) => { const c = []; for (const ch of b.children) P.walkLeaves(ch, ch.relBits, ch.name, (n, off, nm) => { if (nm === p) c.push([n, off]); }); return c[0]; };
  const [spd, spdoff] = read('Speed');
  check('Speed value', Math.round(P.decodeLeaf(spd, b.image.buffer, spdoff) * 100) / 100, 12.5);
  check('Name value', P.decodeLeaf(read('Name')[0], b.image.buffer, read('Name')[1]), 'Conveyor-01');
  const [cnt, cntoff] = read('Count');
  check('Count from BEGIN', P.decodeLeaf(cnt, b.image.buffer, cntoff), '100');
}
{
  const r = P.parse(fs.readFileSync(path.join(dir, 'DB12_AGV.db'), 'utf8'), {});
  const b = r.blocks[0];
  check('AGV size', b.sizeBytes, 120);
  const map = {};
  for (const c of b.children) P.walkLeaves(c, c.relBits, c.name, (n, off, p) => { map[p] = off; });
  check('Station[1].PalletNo', map['Station[1].PalletNo'], 32);
  check('Station[8].Height', map['Station[8].Height'], (7 * 96 + 64));
  check('Total', map['Total'], 768);
  check('UpdateTime', map['UpdateTime'], 784);
  check('Code[0,1]', map['Code[0,1]'], 848);
  check('Code[1,3]', map['Code[1,3]'], 848 + 5 * 16);
}
{
  const r = P.parse(fs.readFileSync(path.join(dir, 'DB_Line.db'), 'utf8'), { udts });
  const b = r.blocks[0];
  check('DB_Line size', b.sizeBytes, 52);
  const map = {};
  for (const c of b.children) P.walkLeaves(c, c.relBits, c.name, (n, off, p) => { map[p] = off; });
  check('Motors[2].Current', map['Motors[2].Current'], 96 + 32);
  const cur = [];
  for (const c of b.children) P.walkLeaves(c, c.relBits, c.name, (n, off, nm) => { if (nm === 'Motors[2].Current') cur.push(P.decodeLeaf(n, b.image.buffer, off)); });
  check('Motors[2].Current value', cur[0], '6.5');
}
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
