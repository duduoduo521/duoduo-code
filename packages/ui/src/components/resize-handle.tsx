import { splitProps, type JSX } from "solid-js"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  collapseThreshold?: number
  /** Keyboard resize step size. */
  step?: number
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "collapseThreshold",
    "step",
    "class",
    "classList",
  ])

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const start = local.direction === "horizontal" ? e.clientX : e.clientY
    const startSize = local.size
    let current = startSize

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"

    const onMouseMove = (moveEvent: MouseEvent) => {
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta =
        local.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : edge === "start"
            ? start - pos
            : pos - start
      current = startSize + delta
      const clamped = Math.min(local.max, Math.max(local.min, current))
      local.onResize(clamped)
    }

    const onMouseUp = () => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)

      const threshold = local.collapseThreshold ?? 0
      if (local.onCollapse && threshold > 0 && current < threshold) {
        local.onCollapse()
      }
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const horizontal = local.direction === "horizontal"
    const step = local.step ?? 1
    let delta = 0
    if (horizontal) {
      if (e.key === "ArrowLeft") delta = -step
      else if (e.key === "ArrowRight") delta = step
      else return
    } else {
      if (e.key === "ArrowUp") delta = -step
      else if (e.key === "ArrowDown") delta = step
      else return
    }
    e.preventDefault()
    const current = local.size + delta
    const clamped = Math.min(local.max, Math.max(local.min, current))
    local.onResize(clamped)
    const threshold = local.collapseThreshold ?? 0
    if (local.onCollapse && threshold > 0 && current < threshold) {
      local.onCollapse()
    }
  }

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation={local.direction === "vertical" ? "horizontal" : "vertical"}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    />
  )
}
