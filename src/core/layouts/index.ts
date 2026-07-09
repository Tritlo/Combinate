/**
 * The layout system: pure `term → node positions` algorithms (functional core, ADR 0001), one per
 * module. This barrel is the single import surface — `import { ... } from "../core/layouts"`.
 */
export * from "./types";
export { layoutTopDown } from "./topdown";
export { layoutRadial } from "./radial";
export { layoutHTree, layoutHTreeSubtree, resolveAutoLayout, layoutAuto } from "./htree";
export { layoutBotanical } from "./botanical";
export { layoutMobile } from "./mobile";
export { layoutHyperbolic } from "./hyperbolic";
export { layoutSphere } from "./sphere";
export { layoutHTree3D } from "./htree3d";
export { layoutBotanical3D } from "./botanical3d";
export { layoutMobile3D } from "./mobile3d";
