# 20. The 3D view is a secondary feature, not the headline

The packed-sphere 3D view (plan 06) is a fun, exploratory feature — **not the end goal**. It is
brittle: DOM-mounted WebGL didn't render reliably in real browsers (the discovery card had to drop
to a 2D drawing), and the per-step reduction morph caps at 600 nodes. So we constrain 3D to the
dedicated full-screen 3D view; the **zoo creature picture and the discovery card default to 2D**
(the zoo keeps an opt-in 3D toggle). The core experience stays 2D, where it is robust. Keep 3D lean;
don't make anything load-bearing depend on it.

## Left/right in 3D

A combinator app has a function child (left) and an argument child (right). 2D draws fn solid / arg
dashed; 3D had only warm/cool colour on thin lines, which doesn't read under depth + occlusion (the
complaint when the view was posted on X). Fix (council consensus): **arg edges are now DASHED**
(`LineDashedMaterial`), fn solid, with bumped opacity — the 3D echo of the 2D legend. Not thick
lines (WebGL caps `lineWidth` at 1, and thickness doesn't encode left/right anyway); if dashing ever
reads as noisy, the fallback is a small instanced marker at the arg end, not `Line2`.

## Open direction — large/deep trees (council-discussed, deferred)

2D can't fit large deep trees legibly; the 3D sphere could in principle show more — but perf caps it
(NODE_CAP 20k static; 600-node morph). Council consensus on the path, when we take it up:
**semantic level-of-detail / focus+context first, not raw node count** — collapse deep or
camera-distant subtrees into a single summary glyph (with a count/weight), expand on zoom, keep the
root→focus corridor expanded; then frustum + distance culling. The key insight: the uniform shell
layout makes 100k nodes *less* legible, not more, so chasing node count is the wrong goal — the real
win for "see a big deep tree" is focus+context (possibly even a 2D hyperbolic/fisheye view). Defer
instanced edges, GPU layout, and point-cloud mode.
