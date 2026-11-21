import { HttpHostClient } from './client.js'
import { Session, readBootstrap } from './session.js'
import { Transport } from './transport.js'
import { PageUi } from './ui.js'
import type { PageContext } from './types.js'

export { HttpHostClient, checkedBytes, decodeCacheEntry, readRange } from './client.js'
export { HostError, SdkError } from './error.js'
export { parseJson, stringifyJson, encodeJson, decodeJson } from './json.js'
export { readBootstrap } from './session.js'
export { PageUi } from './ui.js'
export type * from './types.js'
export type * from '../../contract/types/contract.js'

/** 每个 iframe 只建立一个实例，页面隐藏/关闭时取消所有在途读取并清除内存令牌。 */
export function createPageApp(options: { frame?: Window; fetch?: typeof fetch } = {}): { context: PageContext; host: HttpHostClient; ui: PageUi; refreshSession: () => Promise<void>; closeSession: () => Promise<void>; dispose: () => void } {
  const frame = options.frame ?? window
  const bootstrap = readBootstrap(frame)
  const session_token = bootstrap.session_token, expires_at = bootstrap.expires_at
  const context: PageContext = Object.freeze({ contract: bootstrap.contract, app: bootstrap.app, host_origin: bootstrap.host_origin, api_base: bootstrap.api_base, backend_base: bootstrap.backend_base, ui_nonce: bootstrap.ui_nonce, theme: bootstrap.theme, launch: bootstrap.launch })
  const session = new Session(session_token, expires_at)
  const transport = new Transport(context.host_origin, options.fetch ?? frame.fetch.bind(frame), (signal, refresh) => session.token(signal, refresh))
  session.attach(transport)
  const host = new HttpHostClient(transport, context.backend_base, context.host_origin)
  const ui = new PageUi(frame, context)
  const dispose = () => { frame.removeEventListener('pagehide', dispose); transport.close(); session.close(); ui.dispose() }
  frame.addEventListener('pagehide', dispose, { once: true })
  return { context, host, ui, refreshSession: () => session.refresh(), closeSession: async () => { try { await host.closeSession() } finally { dispose() } }, dispose }
}
