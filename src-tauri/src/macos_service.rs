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
//! The workflow runs `open -na "Lyceum" --args <folder>`, which the
//! single-instance plugin in `lib.rs` turns into a new window for that folder.
//! It targets the app by name via LaunchServices, so it needs no CLI shim.
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
					<string>for f in "$@"; do
  open -na "Lyceum" --args "$f"
done</string>
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

    // Only touch disk when content differs, so a normal launch is a no-op.
    let changed = file_differs(&info, INFO_PLIST) || file_differs(&wflow, DOCUMENT_WFLOW);
    if !changed {
        return Ok(());
    }

    std::fs::create_dir_all(&contents)?;
    std::fs::write(&info, INFO_PLIST)?;
    std::fs::write(&wflow, DOCUMENT_WFLOW)?;

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
