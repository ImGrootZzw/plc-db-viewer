const fs = require('fs');
const path = require('path');

const dir = __dirname;
const tpl = fs.readFileSync(path.join(dir, 'src/template.html'), 'utf8');
const parser = fs.readFileSync(path.join(dir, 'src/dbparse.js'), 'utf8');
const app = fs.readFileSync(path.join(dir, 'src/app.js'), 'utf8');

const out = tpl
  .replace('<!--PARSER-->', '<script>\n' + parser + '\n</script>')
  .replace('<!--APP-->', '<script>\n' + app + '\n</script>');

const target = path.join(dir, 'index.html');
fs.writeFileSync(target, out, 'utf8');
console.log('built:', target, (out.length / 1024).toFixed(1) + ' KB');
