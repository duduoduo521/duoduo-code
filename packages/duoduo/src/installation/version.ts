declare global {
  const DUODUO_VERSION: string
  const DUODUO_CHANNEL: string
}

export const InstallationVersion =
  typeof DUODUO_VERSION === "string"
    ? DUODUO_VERSION
    : "local"
export const InstallationChannel =
  typeof DUODUO_CHANNEL === "string"
    ? DUODUO_CHANNEL
    : "local"
export const InstallationLocal = InstallationChannel === "local"
