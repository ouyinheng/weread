# 微信读书复刻（本地版）

把本地 TXT / EPUB / Markdown 文件导入手机，按微信读书的阅读体验来读：书架、翻页、目录、进度、书签、划线、想法、主题和字体设置。

项目是纯本地应用，没有账号、书城后台、云同步，所有书和阅读数据都保存在设备本地（Android 用 SQLite，浏览器预览用 IndexedDB）。

**仓库和安装包都不附带任何书籍文件、书源或影视源。** 书要自己导入；要用在线内容，得自己在「书源管理 / 视频源管理」里填接口地址。导入什么、看什么由用户决定，来源是否合法也由用户自行确认。

<p align="center">
  <img src="assets/screenshots/overview.png" alt="界面预览：书架、阅读、影视详情、播放" />
</p>

## 功能

- **本地导入**：`.txt` / `.epub` / `.md`，自动识别 GBK / UTF-8 编码，支持章节切分和 EPUB3 nav / EPUB2 NCX 目录；同一文件重复导入会被识别并跳过。
- **书架**：封面网格（手机上是三列，卡片宽度固定、列数随屏幕自适应）、7 种排序（默认 / 更新 / 进度 / 书名 / 分类 / 字数 / 作者）、多选批量移除、从头开始；顶部搜索框进入独立搜索页。
- **阅读器**：左右翻页（跟手拖拽）/ 上下滚动、字号 / 边距 / 行距 / 字体 / 主题 / 背景 / 亮度、目录跳章、进度滑块、自动翻页（间隔可调）。
- **阅读记录**：按「章节 + 章内字符偏移」保存进度，换字号或重开应用都能回到原文位置。
- **书签 / 划线 / 想法**：长按选词，支持复制、分享、全选、四色划线、写想法、Markdown 导出；同一章不同页可以有多个书签。
- **书内搜索**：在整本书正文里搜一句话，结果按章节列出并直接跳到命中位置。
- **听书**：默认调用设备自带语音引擎逐句朗读（不联网），也可选联网音色；句级跟随高亮、章末自动续播、定时关闭、金句收藏、全屏听书页与底部迷你条。
- **在线书源**（默认关闭）：导入符合通用书源格式的 JSON 配置，接自己准备的内容来源；搜索、加入书架、按需取章节正文都在本机完成，数据不出设备。
- **影视**（默认不显示入口）：在「我 → 视频源管理」填入自己的影视接口地址后，可多源聚合搜索、看详情、切线路选集、HLS 播放与自动连播；播放页有编号选集条、倍速、全屏横屏。源与播放进度独立存放，不写书库。入口在「系统设置 → 显示影视入口」打开。
- **投屏**：播放页控制栏的投屏按钮会搜索同一 Wi-Fi 下的电视 / 盒子（DLNA / UPnP AV），选中即把当前集推到电视上播；手机侧改为「正在投屏到 XXX」，可随时停止。换集时电视跟着换。
- **备份 / 恢复**：整库导出为 zip（书籍、进度、书签、划线、设置、原始文件），换机或清数据后可一键恢复。
- **个人页**：在读 / 读完 / 笔记 / 书签统计、累计阅读时长、本地占用与配额预警。
- **移动端适配**：Android 返回键、状态栏 / 导航栏 / 左右切边安全区（挖孔屏、刘海屏、横屏侧边凹陷都不会压住图标和按钮）、防锁屏 / 横屏 / 音量键翻页、触觉反馈、深色模式、应用内确认弹窗。
- **默认不联网**：所有数据本地存储；网络书源与联网音色都需要用户主动开启。

## 技术栈

- Vue 3 `<script setup>` + TypeScript
- Vite
- Pinia
- Vue Router
- Capacitor 8（Android）
- SQLite（Android，`@capacitor-community/sqlite`）/ IndexedDB（浏览器与测试）
- JSZip（EPUB 解析、备份打包）
- ArtPlayer + hls.js（影视播放）
- 投屏：自研 Capacitor 插件，`java.net` + OkHttp 直连 SSDP / SOAP（不依赖 Cast SDK 与 Google Play 服务）

## 目录

```text
src/
├── views/                 # 书架 / 我 / 搜索 / 阅读器 / 目录 / 设置 / 字体选择 / 书源
│   └── tv/                # 影视首页 / 搜索 / 详情 / 播放
├── components/            # 图标、TabBar、封面、导入浮层、加载动画、确认弹窗
│   ├── reader/            # 阅读器顶栏、底栏、字体 / 主题 / 进度 / 笔记 / 目录 / 听书
│   └── tv/                # 投屏设备选择面板
├── audio/                 # 听书：分句、播放状态机、设备语音引擎桥、会话
├── utils/                 # 解析、导入、指纹、进度、划线、备份、弹窗、原生桥接
│   ├── storage/           # SQLite / IndexedDB 两套驱动与一次性迁移
│   ├── source/            # 书源解析、网络层、取正文管线
│   ├── tv/                # 影视接口客户端、缓存、收藏与历史
│   └── cast.ts            # 投屏设备发现与连接
├── stores/                # Pinia：书籍、章节、书签、阅读设置、应用设置、书源、影视
├── router/                # 路由与 Tab 注册表
├── styles/                # 主题变量与全局移动端样式
├── types/                 # 数据模型
android/                   # Capacitor Android 壳（MainActivity / Gradle / 本地 TTS 与投屏插件）
tests/                     # 单元测试、CDP 浏览器端到端测试、截图脚本
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

版本号只有一个来源：`package.json` 的 `version`。Gradle 读它生成 `versionName`，
并按 `major*10000 + minor*100 + patch` 推出单调递增的 `versionCode`；前端也由 Vite
注入同一个值，所以设置页「关于」里显示的版本和安装包信息永远一致。**发版只需要改
`package.json` 一处。**

先准备发布签名（只需一次）：

```bash
keytool -genkeypair -v -keystore android/weread-release.jks -alias weread \
  -keyalg RSA -keysize 4096 -validity 10000
```

然后在 `android/keystore.properties` 里写上口令（该文件与 jks 都在 `.gitignore` 里，
不会入库）：

```properties
storeFile=weread-release.jks
storePassword=<刚才设的口令>
keyAlias=weread
keyPassword=<刚才设的口令>
```

构建正式包：

```bash
npm run build
./node_modules/.bin/capacitor sync android
cd android
./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`。

核对一下再发：

```bash
$ANDROID_HOME/build-tools/36.0.0/aapt2 dump badging app-release.apk | head -1
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs app-release.apk
```

**没有 `keystore.properties` 时 release 变体不签名，装不上**——这是有意的，避免把
一个调试密钥签的包当成正式版发出去。日常联调用 `./gradlew assembleDebug`，产物在
`build/outputs/apk/debug/`。

Android 构建需要 JDK 21 和本机 Android SDK（`compileSdk 36`）；SDK 路径写在
`android/local.properties`（该文件不入库）。

## 测试

```bash
npm test          # 26 套单元测试
npm run typecheck # vue-tsc，检查 src 源码
npm run lint      # ESLint（Vue + TypeScript）
npm run format    # Prettier
npm run test:e2e  # 真实 Chrome 端到端（需要先启动 dev server）
```

`test:e2e` 使用 Chrome DevTools Protocol，在 400×890 / @3x 视口下验证分页、交互、Tab 切换、弹窗和划线链路；另有 `tests/tabbar.browser.mjs`（底栏与转场帧率）和 `tests/listen-background.browser.mjs`（后台听书）。
`tests/device*.mjs` 是真机驱动：连 adb 转发出来的 WebView 调试口，可以点按、填表、截图，用来验证只在 Android 上才有的能力（投屏、原生栏、全屏）。
`tests/readme-shots.mjs` 生成 README 顶部那张预览图（静态 dist + mock 影视接口 + 样例书，不需要外网）。

## 数据存储

Android 使用 SQLite（表结构见 `src/utils/storage/sqlite-driver.ts`）；浏览器预览与单测使用 IndexedDB，两者由 `src/utils/db.ts` 统一选驱动，视图与 Pinia store 不感知差异。

首次在 Android 启动时，会在后台把 IndexedDB 的文本数据复制到 SQLite，校验条数通过后打标记，**下一次启动**才切换；失败继续使用 IndexedDB。原始书籍字节仍留在 IndexedDB 的 `files` store，后续再迁到文件系统。

数据库名 `weread`，IndexedDB 当前版本 v6，store：

| store        | 内容                                        |
| ------------ | ------------------------------------------- |
| `books`      | 书籍元数据与最后阅读位置                    |
| `chapters`   | 每章标题、HTML / 纯文本、字数、在线章节地址 |
| `files`      | 导入时的原始字节，供解析器升级后重建        |
| `bookmarks`  | 书签                                        |
| `highlights` | 划线 / 想法字符区间                         |
| `sessions`   | 累计阅读时长                                |
| `settings`   | 阅读设置、应用设置                          |
| `sources`    | 在线书源配置（默认关闭）                    |
| `daily`      | 每天的阅读毫秒数                            |

进度只存 `(章节索引, 章内字符偏移)`，不存页码，所以换字号、行距、屏幕宽度后仍能恢复。在线书额外记录上次阅读的章节 URL，目录增删后优先按 URL 对回原位置。

启动时会请求 `navigator.storage.persist()`，降低磁盘紧张时数据库被系统回收的概率。设置页的「备份到文件 / 从备份恢复」把上述 store 连同原始字节打包成 zip；恢复是覆盖式的，换机或清数据前请先备份。

## 参考

界面结构、翻页手感和交互流程参考了微信读书的公开界面，影视与书源两块的做法参考了两个开源项目的公开文档：

- **LibreTV**（AGPL-3.0）——影视模块的页面结构与「多源聚合搜索 → 详情 → 选集 → 播放」这条交互链路。
- **legado / 阅读**——书源配置的字段思路（搜索 / 详情 / 目录 / 正文四段）。

两个项目都只作思路参考，本仓库不包含它们的源码，也**不附带、不推荐任何具体来源**。

## 范围说明

本项目刻意不做：在线书城运营、账号登录、付费会员、云同步、社交关注，也不内置书源 / 视频源。底部默认是「书架 / 我」两个入口（「影视」需在系统设置中开启），搜索从书架进入独立页面。听书默认使用设备自带语音引擎，也可选联网音色；在线书源默认关闭，需用户主动开启。

## 说明

这是一个学习性质的开源实现，与微信读书官方无关，不包含其商业代码、字体或内容资源。正文默认使用设备系统字体，所有书籍由用户自行导入；项目不提供任何内容，也不对第三方接口的可用性与合法性负责。
