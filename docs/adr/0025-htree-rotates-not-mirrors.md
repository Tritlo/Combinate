# 25. The 2D H-tree rotates per level, it doesn't mirror

The 2D H-tree used a fixed sign rule — fn always left/up, arg always right/down, axis
alternating by depth. Swapping two axes is an odd map (det −1), so a subterm one level
deeper drew as a *mirror image* of its standalone layout: expanded S (= `ι K` exactly, by
bitcode `0 1 0101011`) did not contain a rotated expanded K, but a reflected one. The 3D
H-tree never had this problem — its X→Y→Z axis cycle is an even permutation (det +1), a
true 120° rotation — so 2D and 3D disagreed on chirality.

Decision: the arg-side split direction now **rotates a clockwise quarter-turn per depth**
(right, down, left, up; fn opposite — `HTREE_DIRS` in `layout.ts`). One level deeper is a
true 90° rotation, so subterm pictures are rotated copies of their standalone pictures and
compose visibly (S ⊃ rotated K), matching the 3D behavior. The non-overlap guarantee is
untouched (the `HTREE_SHRINK < 1/√2` extent bound is per split axis, sign-agnostic), and
`layoutHTreeSubtree` reflow is unchanged (verified: subtree re-place == full-layout slice).

Cost: "fn is always left/up" no longer holds below the root — fn/arg is carried by edge
style (solid/dashed; legend re-worded), and deep spines now coil into rectangular spirals
instead of marching down-right as staircases. Root-level reading order (fn left at depth 0)
and drag/snap semantics are unaffected.
