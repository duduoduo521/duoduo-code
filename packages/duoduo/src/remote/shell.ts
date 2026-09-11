import { Client, type ClientChannel } from "ssh2"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { getCredential } from "../storage/credential"
import { KEY_DIR } from "../storage/credential-crypto"
import { Log } from "../util"
import { errorMessage } from "../util/error"

const log = Log.create({ service: "remote-shell" })

interface ResolvedSecret {
  username: string
  password?: string
  privateKey?: Buffer
  passphrase?: string
}

function resolveSecret(credentialRef: string): ResolvedSecret {
  const cred = getCredential(credentialRef)
  if (!cred) throw new Error(`credential not found: ${credentialRef}`)
  if (cred.auth === "password") {
    return { username: cred.username, password: cred.secret }
  }
  const keyPath = path.join(KEY_DIR, `${cred.id}.key`)
  return {
    username: cred.username,
    privateKey: existsSync(keyPath) ? readFileSync(keyPath) : undefined,
    passphrase: cred.secret || undefined,
  }
}

export interface RemoteConnection {
  host: string
  port: number
  remotePath: string
  credentialRef: string
}

/**
 * Open a raw interactive SSH shell (`client.shell()`) on the remote host.
 * Returns the live `ClientChannel` plus the underlying client so callers can
 * adapt it to the local `Proc` interface and tear the connection down.
 */
export function openSshShell(remote: RemoteConnection): Promise<{ client: Client; stream: ClientChannel }> {
  return new Promise((resolve, reject) => {
    const secret = resolveSecret(remote.credentialRef)
    const client = new Client()
    client.on("ready", () => {
      client.shell(
        {
          term: "xterm-256color",
          cols: 80,
          rows: 24,
        },
        (err, stream) => {
          if (err) {
            client.end()
            return reject(err)
          }
          resolve({ client, stream })
        },
      )
    })
    client.on("error", (err) => {
      // ssh2's error event sometimes emits a plain object (e.g.
      // { level: "client-authentication", message: "..." }) rather than an
      // Error instance. Rejecting it verbatim makes the caller print
      // "[object Object]" with no usable detail. Normalize to a readable Error
      // and log it so the real cause survives the trip to the UI.
      const msg = errorMessage(err)
      log.error("ssh connection error", { host: remote.host, port: remote.port, message: msg, raw: String(err) })
      reject(new Error(`SSH connection to ${remote.host}:${remote.port} failed: ${msg}`))
    })
    client.connect({
      host: remote.host,
      port: remote.port,
      username: secret.username,
      password: secret.password,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
      readyTimeout: 20000,
    })
  })
}

export { resolveSecret, log }
