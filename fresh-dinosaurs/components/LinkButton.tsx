import type { ComponentChildren } from "preact";

export interface LinkButtonProps {
  href?: string;
  class?: string;
  children?: ComponentChildren;
}

export function LinkButton(props: LinkButtonProps) {
  return (
    <a
      {...props}
      class={"btn " +
        (props.class ?? "")}
    />
  );
}

