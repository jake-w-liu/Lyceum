fn main() {
    // Make non-tauri build paths aware of platform-specific cfg flags that are
    // otherwise injected by tauri_build so -D warnings checks do not fail on
    // CI lint/test jobs that intentionally skip build-script execution.
    println!("cargo:rustc-check-cfg=cfg(mobile)");

    let ci = std::env::var("CI").is_ok_and(|value| value == "true");
    // Keep CI checks moving in environments where the Windows resource compiler is
    // unavailable or slow to install (e.g. clippy/test lint jobs on
    // windows-latest). Normal builds and local dev keep tauri_build enabled.
    if ci && std::env::var_os("CI_SKIP_TAURI_BUILD").is_some_and(|value| value != "0") {
        println!("cargo:warning=CI_SKIP_TAURI_BUILD is set; skipping tauri_build for lint/test workflows.");
        return;
    }

    tauri_build::build()
}
