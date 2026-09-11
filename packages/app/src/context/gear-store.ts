import { createSignal } from "solid-js"

export type GearActivation = "command" | "auto" | "global"

export interface GearInfo {
  id?: string
  name: string
  version?: string
  kind?: "native" | "mcp" | "skill" | "plugin"
  activation?: GearActivation
  enabled?: boolean
  description?: string
  license?: string
  has_instructions?: boolean
}

// ── Module-level gear API injection ──
// Desktop mode: the smart-layer context sets this to its authenticated client
// (full URL + Basic Auth). Web dev mode: stays null, falls back to relative
// paths handled by the Vite proxy.
interface GearApiClient {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
}

let _api: GearApiClient | null = null

/** Called by the smart-layer context when its API client becomes available. */
export function setGearApi(api: GearApiClient | null): void {
  _api = api
}

async function gearGet<T>(path: string): Promise<T> {
  if (_api) return _api.get<T>(path)
  const resp = await fetch(path)
  if (!resp.ok) throw new Error(`GET ${path}: ${resp.status}`)
  return resp.json() as Promise<T>
}

async function gearPost<T>(path: string, body?: unknown): Promise<T> {
  if (_api) return _api.post<T>(path, body)
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) throw new Error(`POST ${path}: ${resp.status}`)
  return resp.json() as Promise<T>
}

const [gears, setGears] = createSignal<GearInfo[]>([])
const [loaded, setLoaded] = createSignal(false)

/**
 * Fetch the unified gear list from the backend `/gears` endpoint and cache it
 * process-wide so the slash popover and the submit path share one source.
 */
export async function refreshGears(force = false): Promise<void> {
  if (loaded() && !force) return
  try {
    const data = await gearGet<GearInfo[]>("/gears")
    setGears(Array.isArray(data) ? data : [])
  } catch {
    // The gears endpoint is optional; degrade gracefully (no slash entries)
    // when no gear backend is present or the request fails.
  } finally {
    setLoaded(true)
  }
}

export function gearList(): GearInfo[] {
  return gears()
}

/** Gears whose activation is "command" (manual / trigger via `/<name>`). */
export function commandGearList(): GearInfo[] {
  return gears().filter((g) => g.activation === "command")
}

export function isCommandGear(name: string): boolean {
  return gears().some((g) => g.activation === "command" && g.name === name)
}

/**
 * Route a `/<gear>` slash command to the backend activate endpoint. For
 * command-gears this injects the gear's instructions into the session so the
 * user's next message is augmented with the gear's workflow.
 */
export async function activateGear(name: string): Promise<void> {
  await gearPost(`/gears/${encodeURIComponent(name)}/activate`)
}
