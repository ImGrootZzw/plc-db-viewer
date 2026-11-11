# PLC DB Viewer

西门子 PLC 数据块（DB）源文件解析器。单文件、纯前端、离线运行，文件不会离开浏览器。

在线使用：<https://imgrootzzw.github.io/plc-db-viewer/>（GitHub Pages）

## 能做什么

把 TIA Portal / STEP 7 导出的 `.db` 文本源文件拖进页面，得到：

- **变量清单**：名称、类型、字节偏移与位偏移、长度、声明起始值、按起始值重建的镜像值、注释；结构体与数组可逐层展开
- **内存布局**：按真实偏移比例绘制的地址条，悬停查看成员范围，点击定位到表格
- **原始字节**：16 字节一行的 hex dump，点字节可反查所属变量
- **统计**：块长度、叶子变量数、各类型占比、顶层成员占用排行
- **导出**：CSV（Excel 可直接打开）、打印 / 保存 PDF

工具会顺手解析 S7 地址（如 `DB12.DBX12.3`、`DB12.DBD4`），鼠标悬停在偏移列上可见。

## 支持的文件

- TIA Portal 导出：`DATA_BLOCK "... " ` + `{ S7_Optimized_Access := ... }` + `VAR ... END_VAR`
- STEP 7 V5 导出：`DATA_BLOCK DB n` + `STRUCT ... END_STRUCT`
- UDT 定义（`.udt` / `TYPE ... END_TYPE`），与 DB 一起拖入即可解析 `Array[1..3] of "UDT_x"` 这类引用
- 类型：Bool / Byte / Char / Int / DInt / Word / DWord / Real / LReal / String / WString / Time / Date / TOD / DT / DTL / S5Time / Array（含多维）/ Struct
- 注释：`//` 与 `(* ... *)`
- 初值：声明里的 `:=`，以及 `BEGIN` 段里的赋值（含数组下标和嵌套成员）

## 本地使用

直接双击打开 `index.html`，或：

```bash
npm run build   # 把 src/ 拼成单文件 index.html
```

页面右上角有“载入示例”，无需准备文件就能看到效果。

## 开发

```bash
npm test        # 解析断言 + DOM 桩渲染测试
```

目录结构：

```
index.html          构建产物（GitHub Pages 入口，勿手改）
build.js            把 src/ 拼成单文件
src/dbparse.js      解析器：词法、语法、布局、值编解码（无 DOM 依赖）
src/app.js          界面逻辑
src/template.html   HTML + CSS 模板（含 <!--PARSER--> / <!--APP--> 占位）
test/               Node 测试与样例 .db / .udt
```

## 已知限制

- 只解析**文本源**。`0x70 0x71` 开头的二进制块文件和 TIA 的 XML（SIMATIC SD）导出会给出提示，需要在 TIA 里“生成源文件”后重新导出。
- 优化访问块（S7-1200/1500）没有固定偏移，工具里的偏移是按声明顺序估算的，不能用于绝对地址访问；非优化块按 S7 对齐规则计算，可在左侧切换 4 / 8 字节对齐上限或紧凑模式。
- “镜像值”是按声明初值 + `BEGIN` 赋值重建出来的起始值，不是 PLC 运行时的实际数据。
- 数组在表格中最多展开 500 项，CSV 导出上限 5 万行。
