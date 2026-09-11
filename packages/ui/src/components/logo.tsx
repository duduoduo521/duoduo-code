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
        "max-width": "260px",
        height: "auto",
        "object-fit": "contain",
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
