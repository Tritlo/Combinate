import "./style.css";
import { mountApp } from "./app";
import { mountSplash } from "./splash";

// Boot splash: show the Combinate wordmark + Y combinator art while the app wires
// up its renderer, catalog and assets, advancing a progress bar per startup step
// and fading out once the scene is ready. The four steps mirror mountApp's awaited
// milestones (renderer · catalog · lenses · compiler).
const splash = mountSplash(4);
void mountApp((label) => splash.next(label)).then(
  () => splash.done(),
  () => splash.done(), // even on a startup error, drop the overlay so the page is usable
);
