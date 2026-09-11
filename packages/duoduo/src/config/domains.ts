/**
 * 单一可信源：所有对外域名/URL 常量集中于此，避免散落硬编码。
 * 桌面客户端不读取环境变量覆盖这些默认值（单机桌面分发，域名固定）。
 */

/** 官网根域 */
export const APP_DOMAIN = "https://www.dd322.cn/code"

/** 配置 JSON schema 文档指针（写入用户 config.json 的 $schema） */
export const APP_CONFIG_SCHEMA = `${APP_DOMAIN}/config.json`

/** TUI 配置 JSON schema 文档指针 */
export const APP_TUI_SCHEMA = `${APP_DOMAIN}/tui.json`

/** 主题 JSON schema 文档指针 */
export const APP_THEME_SCHEMA = `${APP_DOMAIN}/theme.json`

/** 更新源根域：CLI 安装通道 + Tauri 自动更新端点共用的单一可信源 */
export const APP_UPDATE_BASE = "https://www.dd322.cn/update/code"

/** CLI 安装版的升级脚本地址（curl 升级通道，由 APP_UPDATE_BASE 派生） */
export const APP_CLI_INSTALL = `${APP_UPDATE_BASE}/cli/cli`

/**
 * CORS 白名单根域（server/middleware.ts 使用，放行该域及其任意级子域）。
 * 注意：修改此值会改变 CORS 放行范围，需同步更新 test/server/middleware*.test.ts。
 */
export const APP_CORS_HOST = "www.dd322.cn"

/** 文档根 */
export const APP_DOCS = `${APP_DOMAIN}/docs`
