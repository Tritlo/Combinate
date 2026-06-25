// Throwaway native harness to eyeball what the re-folder recovers.
use refold::refold;
fn main() {
    let cases = [
        ("S K K (=I)", "(@ (@ S K) K)"),
        ("K I (=A)", "(@ K I)"),
        ("S(KS)K (=B)", "(@ (@ S (@ K S)) K)"),
        ("iota iota (=I)", "(@ iota iota)"),
        ("S I I (=M)", "(@ (@ S I) I)"),
        ("S S K (=X)", "(@ (@ S S) K)"),
        ("x (y z) (=B x y z)", "(@ x (@ y z))"),
        (
            "nested compose",
            "(@ (@ (@ S (@ K S)) K) (@ (@ S (@ K S)) K))",
        ),
    ];
    for (label, input) in cases {
        println!("{label:22}  {input}\n   => {}\n", refold(input));
    }
}
