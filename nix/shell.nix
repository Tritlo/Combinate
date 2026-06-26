# Reproducible toolchain for the MicroHs → WASM build (PLAN.md Phase 0).
#
#   nix-shell nix/shell.nix --run ./nix/build-mhs-wasm.sh
#
# Provides GHC (to build/bootstrap the GHC-built compiler `gmhs`), Emscripten
# (`emcc`, to compile the runtime/compiler slice to WASM), make, git, and GMP.
# Pin `nixpkgs` (flake or a fetchTarball with a sha256) for full reproducibility;
# this defaults to the ambient channel for convenience.
{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  name = "mhs-wasm";
  buildInputs = [
    pkgs.ghc # build gmhs / bootstrap
    pkgs.emscripten # emcc -> WASM
    pkgs.gnumake
    pkgs.git
    pkgs.gmp # MicroHs Integer (optional; needed if USECPP/GMP)
  ];
  shellHook = ''
    echo "mhs-wasm shell:"
    echo "  ghc  $(ghc --numeric-version 2>/dev/null)"
    echo "  emcc $(emcc --version 2>/dev/null | head -1)"
    # Emscripten needs a writable cache dir.
    export EM_CACHE="$PWD/.em_cache"
  '';
}
