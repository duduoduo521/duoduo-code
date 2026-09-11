import { eq } from "drizzle-orm"
import { Database } from "../storage"
import { SshCredentialTable } from "./credential.sql"
import { decryptSecret, encryptSecret } from "./credential-crypto"

export type AuthKind = "ssh-key" | "password"

export interface CredentialInput {
  /** Stable reference, e.g. `host:port`. Stored as `remote.credentialRef`. */
  id: string
  auth: AuthKind
  username: string
  /** Plaintext password or private-key passphrase. Encrypted at rest. */
  secret: string
}

export interface Credential {
  id: string
  auth: AuthKind
  username: string
  secret: string
}

/** Store (or replace) an SSH credential. The secret is encrypted before persisting. */
export function putCredential(input: CredentialInput): void {
  const encrypted = encryptSecret(input.secret)
  const now = Date.now()
  Database.use((db) => {
    db.insert(SshCredentialTable)
      .values({
        id: input.id,
        auth: input.auth,
        username: input.username,
        secretEncrypted: encrypted,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: SshCredentialTable.id,
        set: {
          auth: input.auth,
          username: input.username,
          secretEncrypted: encrypted,
          updatedAt: now,
        },
      })
      .run()
  })
}

/** Read and decrypt a credential by id. Returns `undefined` if not found. */
export function getCredential(id: string): Credential | undefined {
  const row = Database.use((db) =>
    db.select().from(SshCredentialTable).where(eq(SshCredentialTable.id, id)).get(),
  )
  if (!row) return undefined
  return {
    id: row.id,
    auth: row.auth,
    username: row.username,
    secret: decryptSecret(row.secretEncrypted),
  }
}

export function deleteCredential(id: string): void {
  Database.use((db) =>
    db.delete(SshCredentialTable).where(eq(SshCredentialTable.id, id)).run(),
  )
}
