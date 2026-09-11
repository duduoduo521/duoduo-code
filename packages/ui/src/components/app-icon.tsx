import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"
import type { IconName } from "./app-icons/types"

import fileExplorer from "../assets/icons/app/file-explorer.svg"
import finder from "../assets/icons/app/finder.png"
import terminal from "../assets/icons/app/terminal.png"

const icons = {
  "file-explorer": fileExplorer,
  finder,
  terminal,
} satisfies Record<IconName, string>

export type AppIconProps = Omit<ComponentProps<"img">, "src"> & {
  id: IconName
}

export const AppIcon: Component<AppIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList", "alt", "draggable"])

  return (
    <img
      data-component="app-icon"
      {...rest}
      src={icons[local.id]}
      alt={local.alt ?? ""}
      draggable={local.draggable ?? false}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    />
  )
}
