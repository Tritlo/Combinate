# Pinned toolchain for building the MicroHs → WASM batch compiler blob from the
# vendored fork (vendor/microhs), for Combinate's in-browser live Haskell→ι
# compile (ADR 0007). Enter and build with:
#
#   nix-shell nix/shell.nix --run ./nix/build-wasm.sh
#
# Pinned to nixpkgs 25.11 (c12c63c), which provides the exact toolchain MicroHs
# wants: GHC 9.10.3 (builds gmhs) + Emscripten 4.0.12 (emcc, the WASM back-end).
let
  nixpkgs = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/c12c63cd6c5eb34c7b4c3076c6a99e00fcab86ec.tar.gz";
    sha256 = "16bm7pjj38rmp7fvm8yc079yzyjrcyrnn454rq0xgf0qkkan512v";
  };
  pkgs = import nixpkgs { };
in
pkgs.mkShell {
  name = "microhs-wasm";
  packages = [
    pkgs.haskell.compiler.ghc9103 # builds gmhs (the GHC-built MicroHs front-end)
    pkgs.emscripten # emcc — the WASM/JS back-end
    pkgs.gnumake
    pkgs.gcc # native cc for the bootstrap binaries (bin/mhs, mcabal)
    pkgs.git
    pkgs.coreutils
    pkgs.gnused
    pkgs.gawk
  ];
  shellHook = ''
    echo "microhs-wasm shell:"
    echo "  ghc  $(ghc --numeric-version 2>/dev/null)"
    echo "  emcc $(emcc --version 2>/dev/null | head -1)"
  '';
}
