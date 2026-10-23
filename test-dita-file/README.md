# 复杂 DITA 测试文档集

打开 `complex-book.ditamap`，切换到 **Site view** 或 **Book view**，即可用一整套内容检查导航、分页、整书合并、交叉引用、复用、键和条件属性。

这些文件按 DITA 1.3 DTD 编写，`npm run verify` 之外还可以用 DITA-OT 或 Oxygen XML Editor 做 DTD 校验。

## 目录结构

```text
test-dita-file/
├── complex-book.ditamap        # 根 bookmap（章节、部分、附录、术语表、关系表）
├── topics/                     # 所有 .dita 主题
├── common/
│   ├── reuse-library.dita      # conref / conrefend / conkeyref 的共享内容
│   ├── keys.ditamap            # 共享键定义（含 keyscope）
│   └── strict.ditaval          # 条件处理规则
└── images/                     # SVG 图片
```

`topics/mathml_*_test.dita` 同时由核心渲染测试读取，因此不要移动或改名。

## 覆盖的主题类型

| 文件 | 根元素 | 说明 |
| --- | --- | --- |
| `topics/preface.dita` | `topic` | 前言，复用、键、条件、关系链接 |
| `topics/overview.dita` | `topic` | 综合行内标记、列表、CALS 表格、简单表、图片、提示类型、锚点 |
| `topics/how-it-works.dita` | `concept` | 概念正文、`conbodydiv`、行内与块级 MathML |
| `topics/architecture.dita` | `concept` | 图片热点图（`imagemap`）、部署表格、环境条件 |
| `topics/getting-started.dita` | `task` | `prereq` / `context` / `steps` / `choices` / `substeps` / `tasktroubleshooting` |
| `topics/install-cli.dita` | `task` | 标准 `prereq` / `context` / `steps` / `result` / `postreq`、平台条件 |
| `topics/command-reference.dita` | `reference` | `refsyn`、语法、`properties`、退出码表格、消息 |
| `topics/api-reference.dita` | `reference` | 语法图、参数表、`parml`、公式图、SDK 示例 |
| `topics/troubleshooting.dita` | `troubleshooting` | 多个 `troubleSolution`、原因、补救、责任人 |
| `topics/safety.dita` | `concept` | `hazardstatement`、安全符号、操作检查 |
| `topics/release-notes.dita` | `topic` | 版本表格、条件内容、草稿注释、构建元数据 |
| `topics/learning-overview.dita` | `learningOverview` | Learning 特化（通过 `class` 回退到 topic 结构） |
| `topics/glossary-term.dita` | `glossentry` | 术语条目、缩写、词性、状态、用法、符号 |
| `topics/glossary-group.dita` | `glossgroup` | 多个术语条目组成一个术语组 |
| `topics/mathml_prefixed_test.dita` | `topic` | DITA 1.3 的 `m:` 命名空间前缀 MathML |
| `topics/mathml_mfenced_test.dita` | `topic` | `mfenced` 公式（Oxygen 常见导出形式） |

## 复用与键

- 直接复用：`conref` 指向 `common/reuse-library.dita` 的段落、提示和清单。
- 范围复用：`conrefend` 从 `reuse-intro` 复用到 `reuse-middle`。
- 间接复用：`conkeyref` 通过 `reuse-library` 键加元素 id 使用
  `reuse-note`、`reuse-tip`、`reuse-checklist` 和 `reuse-command`。
- 键文本：`product-name`、`product-short`、`version`、`support-email`、`docs-url`。
- 键作用域：`common/keys.ditamap` 在 `admin` 作用域中定义 `role`，主题通过 `admin.role` 引用。
- 键链接：`troubleshooting-topic` 和 `glossary-topic` 让 `xref keyref` 走整条键链。

## 条件处理

`common/strict.ditaval` 定义了 `audience`、`platform`、`product`、`otherprops` 和 `props` 的排除/保留规则。Obsidian 预览默认只高亮条件属性；在窗格标题栏的过滤按钮（或命令“Apply a DITAVAL file”）中选择这个文件后，预览会按它隐藏被排除的内容，在站点视图和书籍视图中也会去掉被排除的 `topicref`。

## 图片

`images/` 中的 SVG 分别用于：

- `architecture.svg`：分层架构与热点图。
- `flow.svg`：三步处理流程。
- `logo.svg`：品牌标志与行内图片。
- `hazard.svg`：安全符号。

## 校验

在仓库根目录运行：

```bash
dita validate -i test-dita-file/complex-book.ditamap
```

该命令应无输出并以退出码 0 结束。用 Oxygen XML Editor 打开 `complex-book.ditamap` 时，DTD 校验应无错误；Oxygen 额外的引用检查（键、conref、主题 id）应能被本目录中显式的 `topicid/elementid` 写法满足。

## 在 Obsidian 中试用

把整个 `test-dita-file` 文件夹复制进库中，打开 `complex-book.ditamap`：

- **Reading view** 查看映射树、章节/附录标签、键定义和关系表。
- **Site view** 查看一页一主题、侧边栏、上一页/下一页和跨页锚点。
- **Book view** 查看整书合并、章节编号与跨主题链接跳转。

站点导航中的 `术语：幂等性` 使用映射里的 `navtitle`，因为 `glossentry` 本身没有 `<title>`。
