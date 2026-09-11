import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

/**
 * Encrypted SSH credentials, keyed by `id` (the `credentialRef` stored on a
 * remote project's `remote` field).
 *
 * Only `username` is stored in plaintext (it is not secret). `secret_encrypted`
 * holds the AES-256-GCM ciphertext of either the login password or the private
 * key passphrase, produced by `storage/credential-crypto.ts`. The private key
 * *file itself* is stored on disk at a path derived from `id` and never in the
 * database.
 */
export const SshCredentialTable = sqliteTable("ssh_credential", {
  id: text().primaryKey().notNull(),
  auth: text().$type<"ssh-key" | "password">().notNull(),
  username: text().notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
})
