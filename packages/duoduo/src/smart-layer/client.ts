import type { SmartLayerConfig } from "./types"
import { context, propagation } from "@opentelemetry/api"

/**
 * SmartLayerError represents an error returned by the duo-smart-layer sidecar.
 */
export class SmartLayerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`SmartLayer error ${status}: ${message}`)
    this.name = "SmartLayerError"
  }
}

/**
 * SmartLayerClient is a lightweight HTTP client for communicating
 * with the duo-smart-layer Rust sidecar.
 *
 * Supports Basic Auth credentials and configurable request timeout.
 */
export class SmartLayerClient {
  private config: SmartLayerConfig
  private authHeader: string | undefined

  constructor(config: SmartLayerConfig, auth?: { username: string; password: string }) {
    this.config = config
    if (auth) {
      const encoded = btoa(`${auth.username}:${auth.password}`)
      this.authHeader = `Basic ${encoded}`
    }
  }

  /** Get the base URL for SSE/streaming endpoints (GET requests). */
  getUrl(): string {
    return this.config.url
  }

  /** Get the Authorization header value (if configured). */
  getAuthHeader(): string | undefined {
    return this.authHeader
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.url}${path}`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    // Inject W3C trace context (traceparent/tracestate) so Rust sidecar
    // can continue the same trace. No-op when OTel is not configured.
    propagation.inject(context.active(), headers)

    if (this.authHeader) {
      headers["Authorization"] = this.authHeader
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeout),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      // Rust UnifiedError serializes as { error: "message", code, ... }
      // Some endpoints may return { message: "..." } instead.
      const message =
        (error as Record<string, string>).error ?? (error as Record<string, string>).message ?? response.statusText
      throw new SmartLayerError(response.status, message)
    }

    return response.json() as Promise<T>
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = params ? `${path}?${new URLSearchParams(params).toString()}` : path
    return this.request<T>("GET", url)
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body)
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body)
  }

  del<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = params ? `${path}?${new URLSearchParams(params).toString()}` : path
    return this.request<T>("DELETE", url)
  }
}
