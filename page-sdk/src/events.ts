import { LIMITS } from '../../contract/types/contract.js'
import type { HostEvent } from '../../contract/types/contract.js'
import { SdkError, HostError } from './error.js'
import { wireObject } from './wire.js'
import { backoff, delay, retryable } from './transport.js'
import type { Transport } from './transport.js'
import type { EventOptions } from './types.js'

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ id: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = '', data: string[] = [], id = '', dataSize = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) return
      pending += decoder.decode(chunk.value, { stream: true })
      for (;;) {
        const index = pending.search(/[\r\n]/)
        if (index < 0 || pending[index] === '\r' && index + 1 === pending.length) break
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1 + Number(pending[index] === '\r' && pending[index + 1] === '\n'))
        if (!line) {
          if (data.length) yield { id, data: data.join('\n') }
          data = []; dataSize = 0; continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'id' && !value.includes('\0')) id = value
        if (field === 'data') { data.push(value); dataSize += new TextEncoder().encode(value).length }
        if (dataSize > LIMITS.MAX_JSON_RESPONSE_BYTES) throw new SdkError('事件流帧过大')
      }
      if (new TextEncoder().encode(pending).length > LIMITS.MAX_JSON_RESPONSE_BYTES) throw new SdkError('事件流行过大')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function* hostEvents(transport: Transport, options: EventOptions = {}): AsyncGenerator<HostEvent> {
  const signal = options.signal ? AbortSignal.any([options.signal, transport.lifetime.signal]) : transport.lifetime.signal
  let cursor = options.cursor, failures = 0
  const seen = new Set<string>()
  for (;;) {
    signal.throwIfAborted()
    let response: Response | undefined
    try {
      response = await transport.request('events', { kind: 'events', headers: cursor ? { 'Last-Event-ID': cursor } : undefined, signal })
      if (response.headers.get('Content-Type')?.split(';')[0] !== 'text/event-stream' || !response.body) throw new SdkError('宿主事件流格式无效')
      for await (const frame of parseSse(response.body, signal)) {
        const event = wireObject('HostEvent', frame.data)
        if (typeof event.cursor !== 'string' || !event.cursor || event.cursor !== frame.id || typeof event.event !== 'string' || !Number.isSafeInteger(event.occurred_at) || event.occurred_at < 0 || !Object.hasOwn(event, 'data')) throw new SdkError('事件对象或游标无效')
        cursor = event.cursor
        failures = 0
        if (seen.has(cursor)) continue
        seen.add(cursor)
        if (seen.size > LIMITS.MAX_EVENT_JOURNAL_ENTRIES) seen.delete(seen.values().next().value!)
        // sync.required 和未知事件都原样交付；业务自行重新同步，SDK 不建业务缓存。
        yield event
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof HostError && !retryable(error)) throw error
      if (error instanceof SdkError && response) throw error
      if (failures >= (options.maxReconnects ?? 5)) throw error
    } finally { await response?.body?.cancel().catch(() => {}) }
    if (failures >= (options.maxReconnects ?? 5)) throw new SdkError('宿主事件流持续中断')
    await delay(backoff(failures++), signal)
  }
}
