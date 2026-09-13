import type { Catalog } from './catalog.mjs'

export interface ReleaseRecord {
  id: number
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string | null
}

export interface AssetDigest {
  name: string
  size: number
  sha256: string
}

export interface ReleaseAsset extends AssetDigest {
  buffer: Buffer
}

export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<string>

export function parseReleasePages(content: string): ReleaseRecord[]
export function selectPreviousRelease(releases: ReleaseRecord[], releaseTag: string, expectedDraftId?: number): ReleaseRecord | null
export function verifyMainAncestor(releaseTag: string, run?: CommandRunner): Promise<void>
export function prepareReleaseAssets(options: {
  packagesDir: string
  previousCatalog: Catalog | null
  releaseTag: string
  repository: string
}): Promise<{ catalog: Catalog; assets: ReleaseAsset[] }>
export function verifyDownloadedAssets(directory: string, expectedAssets: AssetDigest[]): Promise<void>
export function publishRelease(options: {
  packagesDir: string
  releaseTag: string
  repository?: string
  temporaryRoot?: string
  run?: CommandRunner
}): Promise<{ catalog: Catalog; assets: AssetDigest[] }>
