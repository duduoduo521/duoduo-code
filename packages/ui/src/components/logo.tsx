import { type JSX } from "solid-js"

type LogoProps = {
  class?: string
  style?: JSX.CSSProperties
}

export const Mark = (props: LogoProps) => {
  return (
    <img
      data-component="logo-mark"
      src="/logo-2000.png"
      alt="Logo"
      class={props.class}
      style={{
        width: "160px",
        height: "200px",
        "object-fit": "contain",
        ...props.style,
      }}
    />
  )
}

export const Splash = (props: LogoProps) => {
  return (
    <img
      data-component="logo-splash"
      src="/logo-2000.png"
      alt="Logo"
      class={props.class}
      style={{
        width: "40%",
        "max-width": "240px",
        height: "auto",
        "object-fit": "contain",
        ...props.style,
      }}
    />
  )
}

// Ring spinner matching the inline splash in packages/desktop/index.html
// (.splash-logo + .splash-status + .ring), so all loading screens look identical.
const SPIN_KEYFRAMES_ID = "duoduo-splash-spin-keyframes"
const ensureSpinKeyframes = () => {
  if (typeof document === "undefined") return
  if (document.getElementById(SPIN_KEYFRAMES_ID)) return
  const el = document.createElement("style")
  el.id = SPIN_KEYFRAMES_ID
  el.textContent = "@keyframes duoduo-splash-spin{to{transform:rotate(360deg)}}"
  document.head.appendChild(el)
}

export const SplashRing = (props: LogoProps) => {
  ensureSpinKeyframes()
  return (
    <div
      data-component="logo-splash-ring"
      class={props.class}
      style={{
        width: "26px",
        height: "26px",
        "border-radius": "50%",
        border: "2.5px solid",
        "border-color":
          "color-mix(in srgb, var(--icon-interactive-base) 40%, transparent) transparent color-mix(in srgb, var(--icon-interactive-base) 40%, transparent) transparent",
        animation: "duoduo-splash-spin 0.8s linear infinite",
        ...props.style,
      }}
    />
  )
}

export const Logo = (props: LogoProps) => {
  return (
    <img
      data-component="logo"
      src="/logo-2000.png"
      alt="Logo"
      class={props.class}
      style={{
        width: "200px",
        height: "auto",
        "object-fit": "contain",
        ...props.style,
      }}
    />
  )
}
