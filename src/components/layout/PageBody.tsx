import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The width of a page body, measured from the same left gutter as the page
 * header:
 *   prose -> max-w-[760px] (forms, settings, reading pages)
 *   data  -> max-w-[1400px] (tables, result lists, split work surfaces)
 *   full  -> no cap (pipelines and grids)
 *
 * There is deliberately no `mx-auto`: a centred body is what made the title
 * start at the gutter while the content started 85px further in.
 */
export type PageBodyWidth = "prose" | "data" | "full";

const WIDTH_CLASS: Record<PageBodyWidth, string> = {
  prose: "max-w-[760px]",
  data: "max-w-[1400px]",
  full: "",
};

export interface PageBodyProps {
  width?: PageBodyWidth;
  className?: string;
  children: ReactNode;
}

export function PageBody({ width = "prose", className, children }: PageBodyProps) {
  return <div className={cn("w-full", WIDTH_CLASS[width], className)}>{children}</div>;
}

export default PageBody;
