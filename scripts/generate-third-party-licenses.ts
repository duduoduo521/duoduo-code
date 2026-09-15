/**
 * ThirdPartyLicenses Generator
 *
 * Scans all npm dependencies (node_modules) and Rust dependencies (Cargo.lock),
 * generates both:
 *   - ThirdPartyLicenses.txt   (root dir, for packaging)
 *   - THIRD-PARTY-LICENSES.html (packages/app/public/, for web display via "About Us")
 *
 * Usage: bun run scripts/generate-third-party-licenses.ts
 * Runs automatically before every release build (release-*.ps1 / release-*.sh).
 */

import { readFile, writeFile } from "fs/promises"
import { basename, dirname, join } from "path"
import { existsSync } from "fs"

interface PkgInfo {
  name: string
  version: string
  license: string
  author: string
  repository: string
  homepage: string | undefined
}

const LICENSE_TEXTS: Record<string, string> = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,

  "Apache-2.0": `Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`,

  "MPL-2.0": `Mozilla Public License Version 2.0
==================================

1. Definitions

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained in the Source Code Form of the
Covered Software, except that You may alter any license notices to the
extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You      *
*  (not any Contributor) assume the cost of any necessary servicing,    *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is    *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by this Mozilla Public License, v. 2.0.`,

  "CC-BY-4.0": `Creative Commons Attribution 4.0 International
Full text: https://creativecommons.org/licenses/by/4.0/legalcode`,

  "CC-BY-3.0": `Creative Commons Attribution 3.0 Unported
Full text: https://creativecommons.org/licenses/by/3.0/legalcode`,

  "BSD-3-Clause": `Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software.

THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND.`,

  ISC: `Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND.`,

  Zlib: `This software is provided 'as-is', without any express or implied warranty.
Permission is granted to anyone to use this software for any purpose.`,
}

const LICENSE_LABELS: Record<string, { zh: string; en: string }> = {
  MIT: { zh: "MIT 许可证", en: "MIT License" },
  "Apache-2.0": { zh: "Apache-2.0 许可证", en: "Apache-2.0 License" },
  "MIT OR Apache-2.0": { zh: "MIT OR Apache-2.0 双许可", en: "MIT OR Apache-2.0" },
  "MPL-2.0": { zh: "MPL-2.0 许可证", en: "MPL-2.0 License" },
  "CC-BY-4.0": { zh: "CC-BY-4.0 许可证", en: "CC-BY-4.0" },
  "CC-BY-3.0": { zh: "CC-BY-3.0 许可证", en: "CC-BY-3.0" },
  "BSD-3-Clause": { zh: "BSD 许可证", en: "BSD License" },
  "BSD-2-Clause": { zh: "BSD-2-Clause 许可证", en: "BSD-2-Clause" },
  ISC: { zh: "ISC 许可证", en: "ISC License" },
  Zlib: { zh: "Zlib 许可证", en: "Zlib License" },
  Unlicense: { zh: "Unlicense 公共领域", en: "Unlicense" },
  "CC0-1.0": { zh: "CC0-1.0 公共领域", en: "CC0-1.0" },
  "NOT-DECLARED": { zh: "未声明", en: "Not Declared" },
}

function normalizeLicense(license: string | undefined): string {
  if (!license) return "NOT-DECLARED"
  const l = license.toUpperCase().trim()
  if (l.includes("GPL") || l.includes("AGPL") || l.includes("LGPL")) return l
  if (l === "MIT" || l.startsWith("MIT*")) return "MIT"
  if (l.includes("APACHE") || l.includes("APACHE-2.0")) return "Apache-2.0"
  if (l.includes("MPL") || l.includes("MPL-2.0")) return "MPL-2.0"
  if (l.includes("CC-BY-4")) return "CC-BY-4.0"
  if (l.includes("CC-BY-3")) return "CC-BY-3.0"
  if (l.includes("BSD-3") || l === "BSD") return "BSD-3-Clause"
  if (l.includes("BSD-2")) return "BSD-2-Clause"
  if (l === "ISC") return "ISC"
  if (l.includes("ZLIB")) return "Zlib"
  if (l === "UNLICENSED" || l === "SEE LICENSE IN LICENSE") return "NOT-DECLARED"
  if (l.includes("MIT") && l.includes("APACHE")) return "MIT OR Apache-2.0"
  if (l.includes("MIT")) return "MIT"
  if (l.includes("BLUEOAK")) return "BlueOak-1.0.0"
  if (l.includes("CC0")) return "CC0-1.0"
  if (l.includes("UNLICENSE")) return "Unlicense"
  if (l.includes("UNICODE")) return "Unicode-3.0"
  return l
}

function formatAuthor(author: unknown): string {
  if (!author) return "(not declared)"
  if (typeof author === "string") return author
  if (typeof author === "object" && author !== null) {
    const a = author as { name?: string; email?: string; url?: string }
    let result = a.name || "(unknown)"
    if (a.email) result += ` (${a.email})`
    return result
  }
  return "(not declared)"
}

function formatRepository(repo: unknown): string {
  if (!repo) return "(not declared)"
  if (typeof repo === "string") return repo
  if (typeof repo === "object" && repo !== null) {
    const r = repo as { url?: string; type?: string }
    if (r.url) return r.url
  }
  return "(not declared)"
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Workspace packages whose `dependencies` are the roots of the shipped
 * dependency closure. Everything the installer put in `node_modules` that is
 * NOT reachable from these through `dependencies` (i.e. devDependencies and
 * their transitive closure) is build-time only and never reaches a user, so it
 * does not belong in a distribution licence list.
 */
const WORKSPACE_DIRS = [
  "",
  "packages/duoduo",
  "packages/app",
  "packages/desktop",
  "packages/ui",
  "packages/sdk/js",
  "packages/plugin",
  "packages/script",
  "packages/shared",
]

async function readPackageJson(dir: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf-8"))
  } catch {
    return undefined
  }
}

/** Node module resolution: `<dir>/node_modules/<name>`, then walk upwards. */
function resolvePackageDir(fromDir: string, name: string): string | undefined {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * `dependencies` + `optionalDependencies` reach the shipped bundle;
 * `devDependencies` and `peerDependencies` do not.
 */
function shippedDependencies(pkg: Record<string, any>): string[] {
  const deps = Object.keys((pkg.dependencies as Record<string, string>) ?? {})
  const optional = Object.keys((pkg.optionalDependencies as Record<string, string>) ?? {})
  return [...new Set([...deps, ...optional])]
}

/**
 * Walk the production dependency closure from every workspace package.
 *
 * Previously this walked all of `node_modules`, which pulled in every build
 * tool as well — harmless for compliance, but it made the list look sloppy
 * (dev-only packages with no `license` field showed up as `NOT-DECLARED`).
 */
async function scanProductionDependencies(root: string, packages: Map<string, PkgInfo>): Promise<void> {
  const visited = new Set<string>()
  const queue: string[] = []

  // Workspace packages are first-party code, not third-party dependencies.
  // Bun links them into node_modules via symlinks, so a naive resolution walk
  // would re-include them (with missing versions) in the licence list. Skip
  // them both by package name and by resolved directory.
  const workspaceNames = new Set<string>()
  for (const ws of WORKSPACE_DIRS) {
    const pkg = await readPackageJson(join(root, ws))
    if (!pkg) continue
    if (pkg.name) workspaceNames.add(pkg.name as string)
  }
  const isWorkspaceDir = (dir: string) => {
    const norm = dir.replace(/\\/g, "/").toLowerCase()
    const rootNorm = root.replace(/\\/g, "/").toLowerCase()
    return WORKSPACE_DIRS.some((ws) => norm === join(rootNorm, ws.replace(/\\/g, "/")))
  }

  for (const ws of WORKSPACE_DIRS) {
    const dir = join(root, ws)
    const pkg = await readPackageJson(dir)
    if (!pkg) continue
    for (const name of shippedDependencies(pkg)) {
      if (workspaceNames.has(name)) continue
      const dep = resolvePackageDir(dir, name)
      if (dep && !isWorkspaceDir(dep)) queue.push(dep)
    }
  }

  while (queue.length > 0) {
    const dir = queue.pop()!
    if (visited.has(dir)) continue
    visited.add(dir)

    const pkg = await readPackageJson(dir)
    if (!pkg) continue
    const name = (pkg.name as string) || basename(dir)
    const version = (pkg.version as string) || "unknown"
    packages.set(`${name}@${version}`, {
      name,
      version,
      license: normalizeLicense(pkg.license as string | undefined),
      author: formatAuthor(pkg.author),
      repository: formatRepository(pkg.repository),
      homepage: pkg.homepage as string | undefined,
    })

    for (const depName of shippedDependencies(pkg)) {
      if (workspaceNames.has(depName)) continue
      const dep = resolvePackageDir(dir, depName)
      if (dep && !visited.has(dep) && !isWorkspaceDir(dep)) queue.push(dep)
    }
  }
}

/**
 * Licences that cannot be discovered automatically.
 *
 * Some packages ship without a `license` field and without a `LICENSE` file in
 * the published tarball. Rather than reporting them as `NOT-DECLARED`, the
 * licence is recorded here with the evidence it was taken from. Entries win
 * over the package's own `license` field, and are keyed by name only so the
 * list does not rot on every version bump.
 */
async function loadManualLicenses(root: string): Promise<Map<string, Partial<PkgInfo>>> {
  const manual = new Map<string, Partial<PkgInfo>>()
  try {
    const raw = await readFile(join(root, "scripts", "third-party-manual.json"), "utf-8")
    const entries = JSON.parse(raw).packages as Array<Partial<PkgInfo>>
    for (const entry of entries) {
      if (entry.name) manual.set(entry.name, entry)
    }
  } catch {
    // No manual list (or unreadable) — automatic detection alone is still valid.
  }
  return manual
}

function applyManualLicenses(packages: Map<string, PkgInfo>, manual: Map<string, Partial<PkgInfo>>) {
  for (const pkg of packages.values()) {
    const override = manual.get(pkg.name)
    if (!override) continue
    if (override.license) pkg.license = normalizeLicense(override.license)
    if (override.repository) pkg.repository = override.repository
    if (override.author) pkg.author = override.author
  }
}

// Resolve full Rust dependency graph with real license metadata via `cargo metadata`.
// Cargo.lock does not contain license fields, so we use `cargo metadata` which exposes
// each package's `license`. Workspace member crates (source === null) are excluded to
// avoid internal UNKNOWN entries. Falls back to [] if cargo is unavailable (parity with
// the existsSync guard used for node_modules).
function parseCargoMetadata(): PkgInfo[] {
  let out: Uint8Array
  try {
    const res = Bun.spawnSync(["cargo", "metadata", "--format-version", "1"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (!res.success) return []
    out = res.stdout
  } catch {
    return []
  }
  // cargo metadata may emit a UTF-8 BOM on some platforms; strip it before parsing.
  let text: string
  if (out[0] === 0xef && out[1] === 0xbb && out[2] === 0xef) {
    text = Buffer.from(out.subarray(3)).toString("utf-8")
  } else if (out[0] === 0xff && out[1] === 0xfe) {
    text = Buffer.from(out.subarray(2)).toString("utf-16le")
  } else {
    text = Buffer.from(out).toString("utf-8")
  }
  let data: { packages: Array<{ name: string; version: string; license?: string; source?: string | null }> }
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const result: PkgInfo[] = []
  for (const p of data.packages) {
    // Skip workspace member crates (no external source) — they are first-party, not third-party.
    if (p.source === null || p.source === undefined) continue
    result.push({
      name: p.name,
      version: p.version,
      license: normalizeLicense(p.license),
      author: "(not declared)",
      repository: "(not declared)",
      homepage: undefined,
    })
  }
  return result
}

// ─── TXT ──────────────────────────────────────────────────────────────

function txtSection(license: string, pkgs: PkgInfo[]): string {
  // Exact match only: a substring match would double-list dual-licence packages
  // (e.g. "MIT OR GPL-3.0-OR-LATER" under the plain "MIT" section) and inflate
  // that section's count.
  const matching = pkgs.filter((p) => p.license === license)
  if (!matching.length) return ""

  let out = `${"=".repeat(80)}\n`
  out += `Section: ${license} (${matching.length} packages)\n`
  out += `${"=".repeat(80)}\n\n`
  const text = LICENSE_TEXTS[license]
  if (text) out += `${text}\n\n`

  for (const p of matching.sort((a, b) => a.name.localeCompare(b.name))) {
    out += `${"-".repeat(78)}\n`
    out += `${p.name} @ ${p.version}\n`
    out += `   Author: ${p.author}\n`
    out += `   Repository: ${p.repository}\n`
    if (p.homepage) out += `   Homepage: ${p.homepage}\n`
    out += `   License: ${p.license}\n`
    out += `${"-".repeat(78)}\n\n`
  }
  return out
}

async function writeTxt(
  pkgs: Map<string, PkgInfo>,
  cargoPkgs: PkgInfo[],
  root: string,
  ts: string,
) {
  const arr = [...pkgs.values(), ...cargoPkgs]
  const groups = new Map<string, PkgInfo[]>()
  for (const p of arr) {
    const k = p.license
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(p)
  }

  let out = `${"=".repeat(80)}\nDuoDuo AI IDE - Third Party Licenses\n${"=".repeat(80)}\n\n`
  out += `Based on opencode (MIT License).\n`
  out += `Copyright (c) 2025 opencode\nCopyright (c) 2026 DuoDuo\n\n`
  out += `Auto-generated: ${ts}\n\n`

  const order = [
    "MIT",
    "Apache-2.0",
    "MIT OR Apache-2.0",
    "MPL-2.0",
    "CC-BY-4.0",
    "CC-BY-3.0",
    "BSD-3-Clause",
    "BSD-2-Clause",
    "ISC",
    "BlueOak-1.0.0",
    "Zlib",
    "Unicode-3.0",
    "Unlicense",
    "CC0-1.0",
    "Python-2.0",
    "NOT-DECLARED",
  ]

  for (const lic of order) out += txtSection(lic, arr)
  for (const [lic, ps] of groups) {
    if (!order.includes(lic)) out += txtSection(lic, ps)
  }
  // Cargo dependencies are merged into the same license-grouped sections above,
  // so each Rust crate appears under its real license (e.g. MPL-2.0) with its
  // full license text. No hardcoded "No GPL/MPL" assertion — data is from cargo metadata.

  out += `${"=".repeat(80)}\nRust (Cargo) Dependencies\n${"=".repeat(80)}\n\n`
  out += `Total Cargo crates resolved via cargo metadata: ${cargoPkgs.length} packages\n`
  out += `Crates are listed above under their respective license sections (MIT / Apache-2.0 / MPL-2.0 / etc.).\n`

  out += `${"=".repeat(80)}\nAudio Assets\n${"=".repeat(80)}\n\n`
  out += `4 WAV sound effects from opencode (MIT License)\nCopyright (c) 2025 opencode\n\n`
  out += `Files: charge.wav, pulse-a.wav, pulse-b.wav, pulse-c.wav\n`
  out += `Location: packages/duoduo/src/cli/cmd/tui/asset/\n\n`

  out += `${"=".repeat(80)}\nFont Assets\n${"=".repeat(80)}\n\n`
  out += `Noto Sans SC (思源黑体) — 303 woff2 unicode-range slices (weights 400/500/600)\n`
  out += `  Source: @fontsource/noto-sans-sc@5.3.0 (https://fontsource.org/fonts/noto-sans-sc)\n`
  out += `  Copyright: Google Inc.\n`
  out += `  License: SIL Open Font License 1.1\n`
  out += `  Full license text ships with the fonts: packages/app/public/assets/fonts/OFL.txt\n\n`
  out += `JetBrains Mono Nerd Font Mono — MIT (Nerd Fonts patch) + Apache-2.0 (JetBrains Mono original)\n`
  out += `System fonts (PingFang SC / Microsoft YaHei / Noto Sans CJK) — OS-bundled\n\n`

  out += `${"=".repeat(80)}\nEnd\n${"=".repeat(80)}\n`
  await writeFile(join(root, "ThirdPartyLicenses.txt"), out, "utf-8")
  console.log(`  ✅ ThirdPartyLicenses.txt (${pkgs.size} npm + ${cargoPkgs.length} cargo)`)
}

// ─── HTML ─────────────────────────────────────────────────────────────

function htmlRow(p: PkgInfo, source: string): string {
  const repo = p.repository !== "(not declared)" ? esc(p.repository) : ""
  const author = esc(p.author)
  const repoCell = repo
    ? `<td class="pkg-repo"><a href="${repo}" target="_blank" rel="noopener">${trunc(repo, 50)}</a></td>`
    : `<td class="pkg-repo" style="color:#666">—</td>`
  return `<tr>
                    <td class="pkg-name">${esc(p.name)}</td>
                    <td class="pkg-ver">${esc(p.version)}</td>
                    <td class="pkg-author">${author}</td>
                    ${repoCell}
                    <td class="pkg-lic">${esc(p.license)}</td>
                    <td><span class="src-npm">${source}</span></td>
                  </tr>`
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s
}

function htmlTable(pkgs: PkgInfo[], source: string): string {
  if (!pkgs.length) return ""
  return `<table>
                <thead><tr>
                  <th>包名 / Package</th>
                  <th>版本 / Version</th>
                  <th>作者 / Author</th>
                  <th>仓库地址 / Repository</th>
                  <th>许可证 / License</th>
                  <th>来源 / Source</th>
                </tr></thead>
                <tbody>
${pkgs
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((p) => htmlRow(p, source))
  .join("\n")}
                </tbody>
              </table>`
}

async function writeHtml(
  pkgs: Map<string, PkgInfo>,
  cargoPkgs: PkgInfo[],
  root: string,
  ts: string,
) {
  const arr = [...pkgs.values()]
  const npmCount = arr.length
  const cargoCount = cargoPkgs.length

  // Build license sections
  const order = [
    "MIT",
    "Apache-2.0",
    "MIT OR Apache-2.0",
    "MPL-2.0",
    "CC-BY-4.0",
    "CC-BY-3.0",
    "BSD-3-Clause",
    "BSD-2-Clause",
    "ISC",
    "BlueOak-1.0.0",
    "Zlib",
    "Unicode-3.0",
    "Unlicense",
    "CC0-1.0",
    "Python-2.0",
    "NOT-DECLARED",
  ]

  let tocItems = ""
  let sections = ""

  for (const lic of order) {
    const matching = arr.filter((p) => p.license === lic)
    if (!matching.length) continue
    const anchor = lic.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    const label = LICENSE_LABELS[lic]?.zh || lic
    const en = LICENSE_LABELS[lic]?.en || lic
    tocItems += `          <li><a href="#${anchor}">${label}</a> (${matching.length})</li>\n`

    const text = LICENSE_TEXTS[lic] || ""
    sections += `
      <section class="license-section">
        <h2 id="${anchor}">${label} <span class="en-sub">${en}</span> <a href="#${anchor}" class="anchor">&para;</a></h2>
        <details open>
          <summary>以下 ${matching.length} 个包使用 ${label}（点击展开/折叠）</summary>
          <div class="license-text"><pre>${esc(text)}</pre></div>
${htmlTable(matching, "NPM")
  .split("\n")
  .map((l) => "          " + l)
  .join("\n")}
        </details>
      </section>\n`
  }

  // Catch remaining licenses
  const groups = new Map<string, PkgInfo[]>()
  for (const p of arr) {
    if (!groups.has(p.license)) groups.set(p.license, [])
    groups.get(p.license)!.push(p)
  }
  for (const [lic, ps] of groups) {
    if (order.includes(lic)) continue
    const anchor = lic.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    tocItems += `          <li><a href="#${anchor}">${lic}</a> (${ps.length})</li>\n`
    sections += `
      <section class="license-section">
        <h2 id="${anchor}">${lic} <a href="#${anchor}" class="anchor">&para;</a></h2>
        <details open>
          <summary>以下 ${ps.length} 个包使用 ${lic}（点击展开/折叠）</summary>
${htmlTable(ps, "NPM")
  .split("\n")
  .map((l) => "          " + l)
  .join("\n")}
        </details>
      </section>\n`
  }

  // Rust (Cargo) sections — grouped by real license from cargo metadata, each crate
  // listed under its license with full license text. Reuses htmlTable with source "Cargo".
  let cargoSections = ""
  if (cargoPkgs.length) {
    const cargoOrder = [
      "MIT",
      "Apache-2.0",
      "MIT OR Apache-2.0",
      "MPL-2.0",
      "BSD-3-Clause",
      "BSD-2-Clause",
      "ISC",
      "BlueOak-1.0.0",
      "Zlib",
      "Unicode-3.0",
      "CC0-1.0",
      "Unlicense",
      "Python-2.0",
      "NOT-DECLARED",
    ]
    const cgroups = new Map<string, PkgInfo[]>()
    for (const p of cargoPkgs) {
      if (!cgroups.has(p.license)) cgroups.set(p.license, [])
      cgroups.get(p.license)!.push(p)
    }
    tocItems += `          <li><a href="#rust">Rust (Cargo) 依赖</a> (${cargoPkgs.length})</li>\n`
    cargoSections += `
      <section class="license-section">
        <h2 id="rust">Rust (Cargo) 依赖 <span class="en-sub">Rust Dependencies by License</span> <a href="#rust" class="anchor">&para;</a></h2>
        <details open>
          <summary>共 ${cargoPkgs.length} 个 Rust crate，按实际许可证分组列出（数据来自 cargo metadata，非硬编码断言）。</summary>
`
    for (const lic of cargoOrder) {
      const ps = cgroups.get(lic)
      if (!ps || !ps.length) continue
      const anchor = "rust-" + lic.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      const label = LICENSE_LABELS[lic]?.zh || lic
      const en = LICENSE_LABELS[lic]?.en || lic
      const text = LICENSE_TEXTS[lic] || ""
      cargoSections += `
          <h3 id="${anchor}">${label} <span class="en-sub">${en}</span> — ${ps.length} crates</h3>
          <div class="license-text"><pre>${esc(text)}</pre></div>
${htmlTable(ps, "Cargo")
  .split("\n")
  .map((l) => "          " + l)
  .join("\n")}
`
    }
    for (const [lic, ps] of cgroups) {
      if (cargoOrder.includes(lic)) continue
      const anchor = "rust-" + lic.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      cargoSections += `
          <h3 id="${anchor}">${lic} — ${ps.length} crates</h3>
${htmlTable(ps, "Cargo")
  .split("\n")
  .map((l) => "          " + l)
  .join("\n")}
`
    }
    cargoSections += `        </details>
      </section>\n`
  }

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>开源许可证声明 / Open Source Licenses - DuoDuo AI IDE</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
        background: #1a1a2e; color: #e0e0e0; line-height: 1.6;
      }
      .container { max-width: 1200px; margin: 0 auto; padding: 40px 24px; }
      header { text-align: center; margin-bottom: 48px; padding-bottom: 32px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      header h1 { font-size: 2rem; font-weight: 700; color: #fff; margin-bottom: 8px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
      header .subtitle { font-size: 1.1rem; color: #888; }
      header .based-on { font-size: 0.85rem; color: #666; margin-top: 8px; }
      .stats { display: flex; justify-content: center; gap: 32px; margin-top: 20px; flex-wrap: wrap; }
      .stats .stat { text-align: center; }
      .stats .stat-num { font-size: 1.8rem; font-weight: 700; color: #667eea; }
      .stats .stat-label { font-size: 0.85rem; color: #888; }
      .toc { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 24px 32px; margin-bottom: 40px; }
      .toc h2 { font-size: 1.1rem; color: #aaa; margin-bottom: 12px; font-weight: 600; }
      .toc ul { list-style: none; display: flex; flex-wrap: wrap; gap: 8px 20px; }
      .toc li { font-size: 0.9rem; }
      .toc a { color: #667eea; text-decoration: none; transition: color 0.2s; }
      .toc a:hover { color: #9b8ceb; text-decoration: underline; }
      .license-section { margin-bottom: 48px; }
      .license-section h2 { font-size: 1.4rem; font-weight: 700; color: #fff; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid rgba(102,126,234,0.3); display: flex; align-items: baseline; gap: 8px; }
      .license-section h2 .en-sub { font-size: 0.9rem; color: #888; font-weight: 400; }
      .license-section h2 .anchor { font-size: 0.8rem; color: #555; text-decoration: none; margin-left: 4px; }
      .license-section h2 .anchor:hover { color: #667eea; }
      details { border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; overflow: hidden; }
      summary { padding: 12px 20px; background: rgba(255,255,255,0.02); cursor: pointer; font-size: 0.95rem; color: #bbb; user-select: none; transition: background 0.2s; }
      summary:hover { background: rgba(255,255,255,0.04); }
      .license-text { padding: 20px 24px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.04); }
      .license-text pre { font-family: "SF Mono", "Fira Code", Menlo, Monaco, monospace; font-size: 0.82rem; line-height: 1.7; color: #aaa; white-space: pre-wrap; word-wrap: break-word; }
      table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
      thead { background: rgba(255,255,255,0.03); }
      th { text-align: left; padding: 10px 12px; color: #888; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid rgba(255,255,255,0.06); }
      td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); color: #ccc; }
      tr:hover td { background: rgba(255,255,255,0.02); }
      .pkg-name { font-weight: 600; color: #e0e0e0; font-family: "SF Mono", "Fira Code", Menlo, Monaco, monospace; font-size: 0.82rem; }
      .pkg-ver { color: #888; font-family: "SF Mono", "Fira Code", Menlo, Monaco, monospace; font-size: 0.80rem; }
      .pkg-author { color: #aaa; font-size: 0.78rem; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pkg-repo { font-size: 0.78rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pkg-repo a { color: #667eea; text-decoration: none; }
      .pkg-repo a:hover { text-decoration: underline; }
      .pkg-lic { color: #667eea; font-size: 0.80rem; white-space: nowrap; }
      .src-npm { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.68rem; font-weight: 600; background: rgba(203,56,55,0.15); color: #cb3837; text-transform: uppercase; }
      footer { text-align: center; padding: 32px 0; margin-top: 48px; border-top: 1px solid rgba(255,255,255,0.06); color: #666; font-size: 0.85rem; }
      footer a { color: #667eea; text-decoration: none; }
      @media (max-width: 768px) { .container { padding: 20px 16px; } header h1 { font-size: 1.5rem; } table { font-size: 0.74rem; } th, td { padding: 6px 8px; } .stats { gap: 16px; } }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1>Open Source Licenses / 开源许可证声明</h1>
        <p class="subtitle">DuoDuo AI IDE 使用的第三方开源组件</p>
        <p class="based-on">基于 opencode 二次开发 — Copyright (c) 2025 opencode, Copyright (c) 2026 DuoDuo — MIT License</p>
        <div class="stats">
          <div class="stat"><div class="stat-num">${npmCount + cargoCount}</div><div class="stat-label">总依赖</div></div>
          <div class="stat"><div class="stat-num">${npmCount}</div><div class="stat-label">NPM 包</div></div>
          <div class="stat"><div class="stat-num">${cargoCount}</div><div class="stat-label">Rust Crates</div></div>
        </div>
      </header>

      <nav class="toc">
        <h2>目录 / Table of Contents</h2>
        <ul>
${tocItems}          <li><a href="#audio">音频资源</a></li>
          <li><a href="#fonts">字体资源</a></li>
        </ul>
      </nav>
${sections}${cargoSections}
      <section class="license-section">
        <h2 id="audio">音频资源 <span class="en-sub">Audio Assets</span> <a href="#audio" class="anchor">&para;</a></h2>
        <details open>
          <summary>4 个 WAV 音效文件（charge, pulse-a, pulse-b, pulse-c）</summary>
          <div class="license-text"><pre>Source: opencode (https://github.com/anomalyco/opencode)
Copyright (c) 2025 opencode
License: MIT

这些音效位于 packages/duoduo/src/cli/cmd/tui/asset/，通过
import ... with { type: "file" } 静态导入（见 cli/cmd/tui/util/sound.ts），
由 TUI 启动界面（cli/cmd/tui/component/logo.tsx）播放。</pre></div>
        </details>
      </section>

      <section class="license-section">
        <h2 id="fonts">字体资源 <span class="en-sub">Font Assets</span> <a href="#fonts" class="anchor">&para;</a></h2>
        <details open>
          <summary>Noto Sans SC（思源黑体，303 个切片）· JetBrains Mono Nerd Font · 系统字体</summary>
          <div class="license-text"><pre>Noto Sans SC（思源黑体）— 303 个 woff2 unicode-range 切片（400/500/600 三档字重）
  Source: @fontsource/noto-sans-sc@5.3.0 (https://fontsource.org/fonts/noto-sans-sc)
  Copyright: Google Inc.
  License: SIL Open Font License 1.1
  许可全文随字体一同分发：packages/app/public/assets/fonts/OFL.txt
  （OFL 1.1 要求许可与版权声明随字体文件一起分发；本切片由 scripts/fetch-fonts.ts 抓取）

JetBrains Mono Nerd Font Mono
  Source: Nerd Fonts project (https://www.nerdfonts.com/)
  License: MIT (Nerd Fonts patch) + Apache-2.0 (JetBrains Mono original)

System Fonts (UI fallback)
  PingFang SC (macOS), Microsoft YaHei (Windows), Noto Sans CJK (Linux)
  上述为操作系统自带字体，无需额外授权。</pre></div>
        </details>
      </section>

      <footer>
        <p>此页面由 <code>scripts/generate-third-party-licenses.ts</code> 自动生成</p>
        <p>生成时间: ${ts}</p>
        <p style="margin-top:8px"><a href="https://github.com/duduoduo521/duoduo-code">DuoDuo AI IDE</a> — MIT License</p>
      </footer>
    </div>
  </body>
</html>`

  await writeFile(join(root, "packages", "app", "public", "THIRD-PARTY-LICENSES.html"), html, "utf-8")
  console.log(
    `  ✅ THIRD-PARTY-LICENSES.html (${npmCount} npm + ${cargoCount} cargo, ${(html.length / 1024).toFixed(0)} KB)`,
  )
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const root = join(import.meta.dir, "..")
  const ts = new Date().toISOString()

  console.log("🔍 Scanning npm dependencies (production closure)...")
  const pkgs = new Map<string, PkgInfo>()
  await scanProductionDependencies(root, pkgs)

  const manual = await loadManualLicenses(root)
  applyManualLicenses(pkgs, manual)
  if (manual.size > 0) console.log(`  Applied ${manual.size} manually declared licences`)
  console.log(`  Found ${pkgs.size} unique npm packages`)

  console.log("🔍 Scanning Cargo dependencies...")
  const cargoPkgs = parseCargoMetadata()
  console.log(`  Found ${cargoPkgs.length} Cargo packages (via cargo metadata)`)

  console.log("\n📄 Generating...")
  await writeTxt(pkgs, cargoPkgs, root, ts)
  await writeHtml(pkgs, cargoPkgs, root, ts)

  console.log("\n✅ Done. Files generated:")
  console.log(`   ThirdPartyLicenses.txt (project root)`)
  console.log(`   packages/app/public/THIRD-PARTY-LICENSES.html`)

  // Check for risky licenses (GPL/AGPL/LGPL/MPL/SSPL/BUSL). MPL is weak copyleft and
  // does not infect the binary, but its license text must ship with the distribution.
  //
  // SPDX 双许可处理：表达式含 " OR " 时，被许可方（我们）可任选其一分支。
  // 只要任一分支为宽松许可（MIT/Apache/BSD/ISC 等），即按该分支分发，无 copyleft 传染。
  // 例：jszip 的 "(MIT OR GPL-3.0-or-later)" 按 MIT 分发，不告警。
  // 注意：仅按顶层 OR 拆分（本仓依赖无 "MIT OR GPL AND X" 式嵌套组合）；
  // 纯 AND 表达式不受影响（AND 是义务叠加，无分支可选，照旧告警）。
  const PERMISSIVE_BRANCH = /\b(MIT|ISC|APACHE[-\s.]?2(\.0)?|BSD|0BSD|UNLICENSE|WTFPL|CC0[-\s.]?1(\.0)?|ZLIB|MS-PL)\b/
  const hasPermissiveAlternative = (license: string): boolean => {
    const upper = license.toUpperCase()
    if (!upper.includes(" OR ")) return false
    return upper
      .replace(/[()]/g, " ")
      .split(/\s+OR\s+/)
      .some((branch) => PERMISSIVE_BRANCH.test(branch))
  }
  const risky = [...pkgs.values()].filter((p) => {
    if (hasPermissiveAlternative(p.license)) return false
    const l = p.license.toUpperCase()
    return (
      l.includes("GPL") || l.includes("AGPL") || l.includes("LGPL") || l.includes("MPL") || l.includes("SSPL") || l.includes("BUSL")
    )
  })
  // 纯构建期依赖：仅参与构建流水线，其产物（CSS 已由 lightningcss 编译进 JS bundle）
  // 不进入最终 release 安装包，故不构成分发合规风险，仅作 INFO 提示。
  // 白名单须与 bun.lock 中 lightningcss 的全部 optionalDependencies 平台变体保持一致。
  const buildOnly = new Set([
    "lightningcss",
    "lightningcss-android-arm64",
    "lightningcss-darwin-arm64",
    "lightningcss-darwin-x64",
    "lightningcss-freebsd-x64",
    "lightningcss-linux-arm-gnueabihf",
    "lightningcss-linux-arm64-gnu",
    "lightningcss-linux-arm64-musl",
    "lightningcss-linux-x64-gnu",
    "lightningcss-linux-x64-musl",
    "lightningcss-win32-arm64-msvc",
    "lightningcss-win32-x64-msvc",
  ])
  if (risky.length > 0) {
    const distributed = risky.filter((p) => !buildOnly.has(p.name))
    const buildTime = risky.filter((p) => buildOnly.has(p.name))
    if (distributed.length > 0) {
      console.warn(`\n⚠️  WARNING: ${distributed.length} packages with restrictive licenses ARE distributed in the release bundle:`)
      for (const p of distributed) {
        console.warn(`   ${p.name} @ ${p.version} — ${p.license}`)
      }
    }
    if (buildTime.length > 0) {
      console.log(`\nℹ️  INFO: ${buildTime.length} packages with restrictive licenses are build-time only (NOT distributed):`)
      for (const p of buildTime) {
        console.log(`   ${p.name} @ ${p.version} — ${p.license} (build-time dependency, not in release bundle)`)
      }
    }
  }
}

main().catch(console.error)
