# 26. The 3D H-tree grows inward: signed 6-cycle, chirality traded for the coil

ADR 25 noted the 3D H-tree's unsigned X→Y→Z axis cycle was "already a rotation" — true,
but that rotation's axis is the (1,1,1) diagonal, and the arg drift has a constant
component along it, so a deep spine marched straight outward (endpoint ≈ 1.9·L0 from the
root, off in one octant). The 2D fix (rotate the split direction so spines coil) has no
free 3D analog: a fixed proper one-level congruence whose direction orbit covers all
three axes *necessarily* drifts along its rotation axis — coil and per-level rotational
congruence are mutually exclusive in 3D.

Decision: take the coil. The arg split direction cycles the **signed** axes
+X, +Y, +Z, −X, −Y, −Z (`DIRS3`, depth mod 6), so a deep spine wraps around the root
(endpoint ≈ L0·(1,s,s²)/(1+s³) ≈ 0.98·L0) instead of running away. Cost: the one-level
congruence map is improper (det −1 — a nested subterm at odd offset is a *mirrored* copy,
the chirality 2D had before ADR 25); two levels apart it is a proper rotation again, and
M⁶ = identity. Non-overlap is unchanged — the same axis recurs every 3 levels and the
extent bound `s³/(1−s³) < 1` is sign-agnostic. The per-node scale map (deep-spine taper)
is orientation-independent and unaffected; the view consumes `pos`/`scale` only.
