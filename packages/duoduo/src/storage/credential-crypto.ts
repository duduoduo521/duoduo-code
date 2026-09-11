import { randomBytes, createCipheriv, createDecipheriv } from "crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { Global } from "../global"

const ALGO = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12
export const KEY_DIR = path.join(Global.Path.data, "ssh-key")
const KEY_FILE = path.join(KEY_DIR, "master.key")

/**
 * Load (or lazily create) the AES-256-GCM master key used to encrypt SSH
 * secrets. The key lives in `<Global.Path.data>/ssh-key/master.key`, created
 * with 0600 permissions. It never leaves the local machine.
 *
 * This is intentionally self-contained (Node/Bun built-in `crypto` only) so it
 * works identically on Windows/macOS/Linux without an OS keychain dependency.
 */
function loadMasterKey(): Buffer {
  if (!existsSync(KEY_FILE)) {
    if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true })
    const key = randomBytes(KEY_BYTES)
    writeFileSync(KEY_FILE, key, { mode: 0o600 })
    try {
      chmodSync(KEY_FILE, 0o600)
    } catch {
      // chmod is a no-op on Windows; ignore.
    }
  }
  return readFileSync(KEY_FILE)
}

let cachedKey: Buffer | undefined
function masterKey(): Buffer {
  if (!cachedKey) cachedKey = loadMasterKey()
  return cachedKey
}

/** Encrypt a plaintext secret. Output is base64 of `iv|authTag|ciphertext`. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, masterKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64")
}

/** Decrypt a secret produced by {@link encryptSecret}. Throws on tamper. */
export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, "base64")
  const iv = raw.subarray(0, IV_BYTES)
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + 16)
  const ciphertext = raw.subarray(IV_BYTES + 16)
  const decipher = createDecipheriv(ALGO, masterKey(), iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8")
}
