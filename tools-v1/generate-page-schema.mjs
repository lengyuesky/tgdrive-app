// 从唯一的生成 TypeScript 推导运行时形状，不在 SDK 手写另一份线上 schema。
import ts from 'typescript'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = ts.createSourceFile('contract.ts', await readFile(resolve(root, 'contract/types/contract.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const aliases = new Map(source.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, node.type]))
const roots = ['PageBootstrap', 'SessionRefreshResponse', 'RuntimeInfo', 'ScopeInfo', 'FileNode', 'DirectoryPage', 'FilePage', 'RandomFilesResponse', 'FileChangesPage', 'MediaUrl', 'ReadLease', 'MutationReceipt', 'UploadInfo', 'KvGetResponse', 'KvRecord', 'KvPage', 'DataUsage', 'CacheEntry', 'CacheLookupResponse', 'ErrorResponse', 'HostEvent', 'UiMessage', 'UiRequest']
const schemas = {}
function schema(node) {
  if (ts.isParenthesizedTypeNode(node)) return schema(node.type)
  if (ts.isIntersectionTypeNode(node)) return { intersection: node.types.map(schema) }
  if (ts.isUnionTypeNode(node)) return { union: node.types.map(schema) }
  if (ts.isArrayTypeNode(node)) return { array: schema(node.elementType) }
  if (ts.isMappedTypeNode(node)) return { any: true }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(source)
    if (name === 'Array') return { array: schema(node.typeArguments[0]) }
    if (name === 'Record') return { any: true }
    if (!aliases.has(name)) throw new Error(`生成类型引用未知别名：${name}`)
    build(name)
    return { ref: name }
  }
  if (ts.isTypeLiteralNode(node)) {
    const fields = {}
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) throw new Error('生成对象包含尚未支持的成员')
      const name = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source)
      fields[name] = { optional: Boolean(member.questionToken), schema: schema(member.type) }
    }
    return { object: fields }
  }
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal
    if (ts.isStringLiteral(literal)) return { literal: literal.text }
    if (literal.kind === ts.SyntaxKind.NullKeyword) return { literal: null }
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return { literal: true }
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return { literal: false }
    throw new Error('生成类型包含尚未支持的字面量')
  }
  const kind = { [ts.SyntaxKind.StringKeyword]: 'string', [ts.SyntaxKind.NumberKeyword]: 'number', [ts.SyntaxKind.BooleanKeyword]: 'boolean', [ts.SyntaxKind.NeverKeyword]: 'never' }[node.kind]
  if (!kind) throw new Error(`生成类型包含尚未支持的语法：${node.getText(source)}`)
  return { kind }
}
function build(name) {
  if (Object.hasOwn(schemas, name)) return
  schemas[name] = null
  schemas[name] = schema(aliases.get(name))
}
for (const name of roots) build(name)
const canonical = Object.fromEntries(Object.keys(schemas).sort().map(key => [key, schemas[key]]))
const text = `// 由 tools-v1/generate-page-schema.mjs 从 contract/types/contract.ts 生成，请勿手改。\nimport type * as C from '../../contract/types/contract.js'\nexport type WireValues = { ${roots.map(name => `${name}: C.${name}`).join('; ')} }\nexport const WIRE_SCHEMAS: Record<string, unknown> = ${JSON.stringify(canonical)}\n`
const path = resolve(root, 'page-sdk/src/wire-schema.ts')
if (process.argv[2] === 'check') {
  if (await readFile(path, 'utf8') !== text) throw new Error('页面运行时形状已过期，请运行 npm run sdk:schema')
} else await writeFile(path, text)
