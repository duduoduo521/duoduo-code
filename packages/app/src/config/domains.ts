/**
 * 前端统一域名常量（与 packages/duoduo/src/config/domains.ts 对应）。
 * 桌面客户端不读取环境变量，域名固定。
 */

/** 官网根域 */
export const APP_DOMAIN = "https://www.dd322.cn/code"

/** 官网主机名（用于 hostname 判断） */
export const APP_HOST = "www.dd322.cn"

/** 主题 JSON schema 文档指针 */
export const APP_THEME_SCHEMA = `${APP_DOMAIN}/theme.json`

/** 文档根 */
export const APP_DOCS = `${APP_DOMAIN}/docs`
