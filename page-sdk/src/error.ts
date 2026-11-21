import { ERROR_CODES } from '../../contract/types/contract.js'
import type { ApiError } from '../../contract/types/contract.js'

export class HostError extends Error {
  readonly code: string
  readonly requestId: string
  readonly details: ApiError['details']
  readonly retryAfterMs: number | undefined
  constructor(readonly status: number, error: ApiError) {
    super(error.message)
    this.name = 'HostError'
    this.code = error.code
    this.requestId = error.request_id
    this.details = error.details
    this.retryAfterMs = error.retry_after_ms ?? undefined
  }
}
export class SdkError extends Error {
  constructor(message: string) { super(message); this.name = 'SdkError' }
}
export function localHostError(code: keyof typeof ERROR_CODES, message: string): HostError {
  return new HostError(ERROR_CODES[code], { code, message, request_id: 'sdk' })
}
