// Platform / app metadata exposed to the frontend.
//
// Kept in its own module (rather than inline in lib.rs) so the pure data logic
// can be unit-tested with `cargo test` without spinning up a Tauri runtime —
// supporting the project's no-bug policy.

use serde::Serialize;

/// Information about the running application and host platform.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppInfo {
    /// Product name.
    pub name: String,
    /// Semantic version from Cargo.
    pub version: String,
    /// Operating system, e.g. "macos", "linux", "windows".
    pub os: String,
    /// CPU architecture, e.g. "aarch64", "x86_64".
    pub arch: String,
}

/// Build the [`AppInfo`] for the current build/platform.
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "lyceum".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_name_and_version() {
        let info = app_info();
        assert_eq!(info.name, "lyceum");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn app_info_reports_nonempty_platform() {
        let info = app_info();
        assert!(!info.os.is_empty(), "os should be populated");
        assert!(!info.arch.is_empty(), "arch should be populated");
    }

    #[test]
    fn app_info_serializes_to_expected_json_shape() {
        let info = app_info();
        let value = serde_json::to_value(&info).expect("serialize AppInfo");
        let obj = value.as_object().expect("AppInfo is a JSON object");
        for key in ["name", "version", "os", "arch"] {
            assert!(obj.contains_key(key), "missing key: {key}");
        }
    }
}
