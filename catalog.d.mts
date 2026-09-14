export type AppPermission = 'files.read' | 'media.read' | 'favorites.write'

interface SettingBase {
  key: string
  label: string
  description?: string
}

export type AppSetting = SettingBase & (
  | { type: 'boolean'; default: boolean }
  | { type: 'number'; default: number }
  | { type: 'string' | 'directory'; default: string }
)

export interface AppManifest {
  id: string
  name: string
  version: string
  api_version: number
  min_host_version: string
  description: string
  author: string
  entry: string
  permissions: AppPermission[]
  settings: AppSetting[]
}

export interface CatalogEntry {
  manifest: AppManifest
  sha256: string
  size: number
  url: string
}

export interface Catalog {
  schema_version: 2
  repository: string
  entries: CatalogEntry[]
}

export interface PackageMetadata {
  manifest: AppManifest
  sha256: string
  size: number
  url?: string
}

export interface CollectedPackage extends PackageMetadata {
  filename: string
  buffer: Buffer
}

export const DEFAULT_REPOSITORY: string
export const MAX_CATALOG_BYTES: number
export const MAX_ENTRIES: number
export const MAX_PACKAGE_BYTES: number
export const MAX_MANIFEST_BYTES: number
export const REPO_PATTERN: RegExp
export const SHA256_PATTERN: RegExp
export const APP_ID_PATTERN: RegExp
export const VERSION_PATTERN: RegExp

export function parsePublishJson(text: string): unknown
export function validateRepository(repository: unknown): asserts repository is string
export function compareStableVersions(left: string, right: string): number
export function validateManifest(manifest: unknown): asserts manifest is AppManifest
export function readLimitedFile(path: string, maxBytes: number, label: string): Promise<Buffer>
export function extractFileFromZip(buffer: Buffer, targetName: string): Buffer | null
export function sha256Hex(buffer: Buffer): string
export function validateEntry(entry: unknown, options?: { repository?: string }): asserts entry is CatalogEntry
export function validateCatalog(catalog: unknown, options?: { repository?: string }): catalog is Catalog
export function serializeCatalog(catalog: Catalog): string
export function parseCatalog(content: Buffer | string, options?: { repository?: string }): Catalog
export function readCatalog(path: string, options?: { repository?: string }): Promise<Catalog>
export function mergeCatalogs(options: {
  currentEntries: PackageMetadata[] | CatalogEntry[]
  previousCatalog?: Catalog | null
  repository?: string
}): Catalog
export function collectPackages(packagesDir: string): Promise<CollectedPackage[]>
export function formatSha256Sums(fileEntries: Array<{ name: string; sha256: string }>): string
export function verifyCatalogPackages(catalog: Catalog, packagesDir: string): Promise<void>
