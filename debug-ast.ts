import { resolve } from "path"

const cases = [`echo x > /tmp/f`, `echo x >> /tmp/f`, `Get-Process | Out-File -FilePath /tmp/f`, `echo x 2>$null`]

const { Parser, Language } = await import("web-tree-sitter")
const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
await Parser.init({ locateFile: () => resolve(import.meta.dir, treeWasm) })
const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
  with: { type: "wasm" },
})
const lang = await Language.load(resolve(import.meta.dir, psWasm))
const parser = new Parser()
parser.setLanguage(lang)

for (const c of cases) {
  const tree = parser.parse(c)
  const dump = (n: any, depth = 0): string => {
    let s = `${" ".repeat(depth)}${n.type}: ${JSON.stringify(n.text)}\n`
    for (let i = 0; i < n.childCount; i++) {
      const ch = n.child(i)
      if (ch) s += dump(ch, depth + 1)
    }
    return s
  }
  console.log(`=== ${JSON.stringify(c)}`)
  console.log(dump(tree.rootNode))
}
