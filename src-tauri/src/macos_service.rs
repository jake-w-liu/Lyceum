//! Installs the "Open in Lyceum" Finder Quick Action (a macOS Service) so users
//! can right-click a folder and open it in Lyceum, the same as running
//! `lyceum .` from a terminal.
//!
//! macOS only. A Service is just a `.workflow` bundle under
//! `~/Library/Services/`; the system picks it up and shows it in the Finder
//! right-click menu (under "Quick Actions"/"Services"). We can't declare this in
//! the app's own `Info.plist` because that route needs a native Cocoa service
//! handler that Tauri doesn't expose — so we drop the bundle on disk on startup.
//!
//! The workflow execs the app binary directly with the folders as arguments —
//! `("<bundle>/Contents/MacOS/lyceum" "$@" >/dev/null 2>&1 &)` — which the
//! single-instance plugin in `lib.rs` turns into a new window per folder.
//! We deliberately do NOT use `open -n`: each forced instance registers a
//! launch with LaunchServices, so every invocation added a running Dock tile
//! that then lingered as a duplicate "recent apps" Dock entry. Exec'ing the
//! binary still reaches the plugin's argv handoff (forward, then exit) but
//! never touches LaunchServices, so no extra Dock entries are created. Using
//! this bundle's own binary path also keeps the target deterministic no matter
//! how many Lyceum.app copies LaunchServices happens to know about.
//!
//! Idempotent: the files are rewritten only when missing or out of date, and the
//! Services cache is flushed only when something actually changed — so a normal
//! launch touches no disk and spawns no subprocess.

#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::process::Command;

const WORKFLOW_NAME: &str = "Open in Lyceum.workflow";

const INFO_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>Open in Lyceum</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
				<string>public.item</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
"#;

const DOCUMENT_WFLOW: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.path</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>@@OPEN_COMMAND@@</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<true/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>11111111-1111-1111-1111-111111111111</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>22222222-2222-2222-2222-222222222222</string>
				<key>UUID</key>
				<string>33333333-3333-3333-3333-333333333333</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:253.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
"#;

/// The direct-exec command when `exe` lives inside a `.app` bundle.
fn command_for_exe(exe: &std::path::Path) -> Option<String> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))?;
    // The path sits inside a double-quoted shell string, so the four chars
    // that stay special there must be escaped (an install path containing a
    // quote or `$` would otherwise corrupt or inject into the command).
    let escaped = exe
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$");
    Some(format!("(\"{escaped}\" \"$@\" >/dev/null 2>&1 &)"))
}

/// The shell command the workflow runs for its selected folders: exec THIS
/// app binary with the folders as argv, detached. Direct exec skips
/// LaunchServices entirely — no forced second instance, so no transient Dock
/// tile and no duplicate "recent apps" entries — while the single-instance
/// plugin still forwards the argv to the running Lyceum and exits. A detached
/// `(… &)` is required for the cold-start case: when nothing is running the
/// exec'd process becomes the primary instance and never returns, so an
/// un-detached command would leave the service hanging until Lyceum quits.
fn open_command() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    command_for_exe(&exe).unwrap_or_else(|| {
        // A bare binary (cargo dev/test) is not inside a bundle, so there is no
        // stable path to exec — keep the pre-fix LaunchServices handoff, which
        // resolves the installed app by name.
        "for f in \"$@\"; do\n  open -na \"Lyceum\" --args \"$f\"\ndone".to_string()
    })
}

/// Escape for embedding in the plist XML `<string>` element.
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Ensure the "Open in Lyceum" Finder Quick Action is installed and current.
/// Best-effort: any error is returned for the caller to log, never fatal.
pub fn ensure_installed() -> std::io::Result<()> {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return Ok(()), // No HOME (unusual) — nothing we can safely do.
    };
    let contents = home
        .join("Library/Services")
        .join(WORKFLOW_NAME)
        .join("Contents");

    let info = contents.join("Info.plist");
    let wflow = contents.join("document.wflow");
    let wflow_text = DOCUMENT_WFLOW.replace("@@OPEN_COMMAND@@", &xml_escape(&open_command()));

    // Only touch disk when content differs, so a normal launch is a no-op.
    let changed = file_differs(&info, INFO_PLIST) || file_differs(&wflow, &wflow_text);
    if !changed {
        return Ok(());
    }

    std::fs::create_dir_all(&contents)?;
    std::fs::write(&info, INFO_PLIST)?;
    std::fs::write(&wflow, wflow_text)?;

    // Refresh the Services cache so the menu item appears without a re-login.
    // Best-effort: if pbs is missing or fails, the item still registers on the
    // next login/Finder restart.
    let _ = Command::new("/System/Library/CoreServices/pbs")
        .arg("-flush")
        .status();

    Ok(())
}

/// True if `path` is absent, unreadable, or its contents differ from `want`.
fn file_differs(path: &PathBuf, want: &str) -> bool {
    match std::fs::read_to_string(path) {
        Ok(have) => have != want,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::{command_for_exe, xml_escape, DOCUMENT_WFLOW};
    use std::path::Path;

    #[test]
    fn command_execs_the_bundled_binary_detached() {
        let cmd =
            command_for_exe(Path::new("/Applications/Lyceum.app/Contents/MacOS/lyceum")).unwrap();
        assert_eq!(
            cmd,
            "(\"/Applications/Lyceum.app/Contents/MacOS/lyceum\" \"$@\" >/dev/null 2>&1 &)"
        );
    }

    #[test]
    fn command_is_none_for_a_bare_binary() {
        assert!(command_for_exe(Path::new("/Users/x/lyceum/target/debug/lyceum")).is_none());
    }

    #[test]
    fn command_escapes_shell_metachars_in_the_exe_path() {
        let cmd = command_for_exe(Path::new(
            "/Users/x/My \"Apps\"/Lyceum $copy.app/Contents/MacOS/lyceum",
        ))
        .unwrap();
        assert_eq!(
            cmd,
            "(\"/Users/x/My \\\"Apps\\\"/Lyceum \\$copy.app/Contents/MacOS/lyceum\" \"$@\" >/dev/null 2>&1 &)"
        );
    }

    #[test]
    fn xml_escape_escapes_ampersand_first() {
        assert_eq!(xml_escape("a&<b>"), "a&amp;&lt;b&gt;");
    }

    #[test]
    fn wflow_template_placeholder_is_substituted() {
        let rendered = DOCUMENT_WFLOW.replace("@@OPEN_COMMAND@@", "test-command");
        assert!(rendered.contains("test-command"));
        assert!(!rendered.contains("@@OPEN_COMMAND@@"));
    }
}
