use std::{path::Path, process::Command};

fn main() {
    // Which commit this app was built from, and the source folder, for Settings → Updates.
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let root = Path::new(&manifest).join("..").join("..").join("..");
    let sha = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=TETHER_GIT_SHA={sha}");
    let source = root
        .canonicalize()
        .map(|p| {
            let s = p.display().to_string();
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=TETHER_SOURCE_DIR={source}");
    // Rebuild the stamp when the checked-out commit changes (only paths that exist, or Cargo reruns always).
    let git = root.join(".git");
    for p in ["HEAD", "refs/heads", "packed-refs"] {
        let path = git.join(p);
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    tauri_build::build()
}
