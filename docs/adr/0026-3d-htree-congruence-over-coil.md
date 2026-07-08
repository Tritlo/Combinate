# 26. 3D H-tree: rotational congruence over the inward coil (coil tried & rejected)

The 3D H-tree's unsigned X→Y→Z split cycle is a proper rotation (120° about the (1,1,1)
diagonal), so every subterm draws as a true rotated copy of its standalone layout — but the
arg drift has a constant component along that same diagonal, so a deep spine marches
outward (endpoint ≈ 1.9·L0 into one octant). We tried the 2D-style fix: a **signed**
6-cycle (+X,+Y,+Z,−X,−Y,−Z) coils the spine around the root (≈ 0.98·L0). It works, but
there is no free lunch in 3D: a fixed one-level congruence whose direction orbit covers
all three axes *necessarily* drifts along its rotation axis if proper — so the coil forces
the one-level map improper (det −1), and nested subterms at odd offsets become **mirrored**
copies (exactly the 2D chirality bug ADR 25 fixed).

Decision (maintainer, after seeing renders from three viewpoints): **rotational congruence
wins — keep the unsigned cycle and the outward growth.** The self-similarity is the more
accurate picture (expanded S really is ι applied to K, and its 3D drawing should contain a
rotated K, not a mirrored one). The outward diagonal march is the accepted cost. Don't
re-attempt the coil without revisiting the mirror trade-off above; 2D keeps both properties
only because its rotation axis points out of the plane.
