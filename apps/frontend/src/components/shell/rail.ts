// The rail's row language, shared by the app sidebar and the settings rail (GET-658, polish round 2).
//
// Drawn from the ⌘K palette, row by row: the label in full ink at 13px regular, the icon a step
// quieter, small light group labels ("Views"), and the selected row a flat soft band with no ring,
// no shadow and no bolding, the way the palette marks the highlighted result.

/** Row frame: the palette's inset, rounded row. Add the padding for open/collapsed yourself. */
export const railRow = "group flex w-full items-center rounded-lg transition-colors duration-fast";
/** Idle hover band, on the warm grey frame. */
export const railIdle = "hover:bg-[hsl(42_16%_91.5%)] dark:hover:bg-white/[0.04]";
/** The selected row: one flat band, like the palette's highlighted result. */
export const railActive = "bg-[hsl(42_17%_89.2%)] dark:bg-white/[0.07]";
/** Icons sit a step under the label. */
export const railIcon = "text-muted-foreground/70";
export const railIconActive = "text-foreground/80";
/** Labels read in full ink; the selected one is the same weight, just on its band. */
export const railLabel = "text-foreground/85 group-hover:text-foreground";
export const railLabelActive = "text-foreground";
/** "Views", "Workspace", "Account": the palette's group label. */
export const railGroupLabel = "text-[11px] font-medium text-muted-foreground/60";
/** Shared icon stroke, the palette's. */
export const RAIL_STROKE = 1.75;
