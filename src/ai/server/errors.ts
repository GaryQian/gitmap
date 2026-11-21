// Typed errors for the /api/ai/* routes. Every failure a handler reports is an AiError; its code is
// one of the AiErrorBody codes from the contract, so the browser can branch on it.
import type { AiErrorBody } from '../../contracts/ai';

export type AiErrorCode = AiErrorBody['error']['code'];

const STATUS: Record<AiErrorCode, number> = {
  disabled: 403,
  no_key: 503,
  too_large: 413,
  rate_limited: 429,
  refused: 422,
  invalid: 400,
  provider: 502,
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(code: AiErrorCode, message: string, opts: { status?: number; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = opts.status ?? STATUS[code];
    this.headers = opts.headers ?? {};
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err: AiError): Response {
  const body: AiErrorBody = { error: { code: err.code, message: err.message } };
  return jsonResponse(body, err.status, err.headers);
}
