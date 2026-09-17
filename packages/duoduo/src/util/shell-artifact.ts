/**
 * Windows shell redirection artifacts.
 *
 * A PowerShell-style `> $null` executed by cmd.exe creates a literal file
 * named `$null` (misquoted device redirection can likewise produce `nul`).
 * They are never user content and must be excluded from review lists and
 * snapshot staging in any directory.
 */
export function isShellArtifactPath(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? file
  const lower = name.toLowerCase()
  return lower === "$null" || lower === "nul"
}
