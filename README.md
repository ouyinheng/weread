# 微信读书复刻（本地版）

把本地 TXT / EPUB / Markdown 文件导入手机，按微信读书的阅读体验来读：书架、翻页、目录、进度、书签、划线、想法、主题和字体设置。

项目是纯本地应用，没有账号、书城后台、云同步，所有书和阅读数据都保存在设备的 IndexedDB 中。

![微读界面预览：书架、阅读、目录](assets/screenshots/overview.png)

## 功能

- **本地导入**：`.txt` / `.epub` / `.md`，自动识别 GBK / UTF-8 编码，支持章节切分和 EPUB 目录。
- **书架**：三列封面网格、7 种排序、搜索、多选、单本删除、重新开始。
- **阅读器**：左右翻页 / 上下滚动、字号 / 边距 / 行距 / 字体 / 主题 / 背景、目录跳章、进度滑块、自动翻页。
- **阅读记录**：按「章节 + 章内字符偏移」保存进度，换字号或重开应用都能回到原文位置。
- **书签 / 划线 / 想法**：长按选词，支持复制、分享、全选、划线、写想法；同一章不同页可以有多个书签。
- **个人页**：在读 / 读完 / 笔记 / 书签统计、累计阅读时长、本地占用。
- **移动端适配**：Android 返回键、状态栏 / 导航栏安全区、触觉反馈、深色模式、应用内确认弹窗。
- **默认不联网**：所有数据本地存储。

## 技术栈

- Vue 3 `<script setup>` + TypeScript
- Vite
- Pinia
- Vue Router
- Capacitor 8（Android）
- IndexedDB（原生 API，无 ORM）
- JSZip（EPUB 解析）

## 目录

```text
src/
├── views/                 # 书架 / 发现 / 我 / 阅读器 / 目录 / 设置 / 字体选择
├── components/            # 图标、TabBar、封面、导入浮层、加载动画、确认弹窗
│   └── reader/            # 阅读器顶栏、底栏、字体 / 主题 / 进度 / 笔记 / 目录
├── utils/                 # 解析、导入、IndexedDB、进度、划线、原生桥接、弹窗
│   └── source/            # 规则解释器、网络层、四段管线
├── stores/                # Pinia：书籍、章节、书签、阅读设置、应用设置
├── router/                # 路由与 Tab 注册表
├── styles/                # 主题变量与全局移动端样式
├── types/                 # 数据模型
android/                   # Capacitor Android 壳（MainActivity / Gradle）
tests/                     # 单元测试 + CDP 浏览器端到端测试
```

## 开发

要求 Node.js 22+。

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。

### 构建 Web

```bash
npm run build
npm run preview
```

### 构建 Android APK

```bash
npm run build
./node_modules/.bin/capacitor sync android
cd android
./gradlew assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。

Android 构建需要 JDK 21 和本机 Android SDK；SDK 路径写在 `android/local.properties`（该文件不入库）。

## 测试

```bash
npm test          # 11 套单元测试
npm run typecheck # vue-tsc，检查 src 源码
npm run test:e2e  # 真实 Chrome 端到端（需要先启动 dev server）
```

`test:e2e` 使用 Chrome DevTools Protocol，在 400×890 / @3x 视口下验证分页、交互、Tab 切换、弹窗和划线链路。

## 数据存储

数据库名 `weread`，当前 v5，store：

| store        | 内容                                        |
| ------------ | ------------------------------------------- |
| `books`      | 书籍元数据与最后阅读位置                    |
| `chapters`   | 每章标题、HTML / 纯文本、字数、在线章节地址 |
| `files`      | 导入时的原始字节，供解析器升级后重建        |
| `bookmarks`  | 书签                                        |
| `highlights` | 划线 / 想法字符区间                         |
| `sessions`   | 累计阅读时长                                |
| `settings`   | 阅读设置、应用设置                          |

进度只存 `(章节索引, 章内字符偏移)`，不存页码，所以换字号、行距、屏幕宽度后仍能恢复。在线书额外记录上次阅读的章节 URL，目录增删后优先按 URL 对回原位置。

## 范围说明

本项目刻意不做：在线书城运营、听书、账号登录、付费会员、云同步、社交关注。底部只有「发现 / 书架 / 我」三个入口；默认「发现」只筛选本地书库。

## 说明

这是一个学习性质的开源复刻实现，不包含微信读书的商业代码、字体或内容资源。正文默认使用设备系统字体，所有书籍由用户自行导入。
