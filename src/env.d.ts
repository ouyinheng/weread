/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 从 package.json 注入，和 APK 的 versionName 同源。 */
declare const __APP_VERSION__: string
