// The app owns setup and the room lifecycle. It does no room work itself. Each
// command runs host/cli.mjs and returns the JSON line that file prints, so the
// browser and the app always agree on one source of truth.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

// A release build is a GUI process with no console. Without this flag, Windows
// gives every console child its own terminal window, which flashes on each
// host call and on the Node helpers the host starts.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
const BUNDLED_NODE_NAME: &str = "node.exe";
#[cfg(not(windows))]
const BUNDLED_NODE_NAME: &str = "node";

const SYSTEM_NODE_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
];

// Prefer an explicit BROSR_NODE override, then the Node runtime bundled inside
// the installed app resources (so fresh Windows and macOS machines never need
// a separate Node.js install), and fall back to system Node for dev runs.
fn resolve_node_binary(
    root: &Path,
    env_override: Option<&str>,
    system_candidates: &[&str],
    path_env: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    if let Some(given) = env_override {
        if !given.is_empty() {
            return Ok(PathBuf::from(given));
        }
    }
    let bundled = root.join("node").join(BUNDLED_NODE_NAME);
    if bundled.is_file() {
        return Ok(bundled);
    }
    for candidate in system_candidates {
        if Path::new(candidate).is_file() {
            return Ok(PathBuf::from(candidate));
        }
    }
    if let Some(path) = path_env {
        // Windows separates PATH entries with `;`, and its executable carries
        // the `.exe` suffix. `split_paths` handles both platforms, and trying
        // both names keeps a Windows shell and a Unix build on one path.
        for dir in std::env::split_paths(path) {
            for name in ["node", "node.exe"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    Err("Node.js was not found. Reinstall Brosr, install Node 20 or later, or set BROSR_NODE.".to_string())
}

fn node_binary(root: &Path) -> Result<PathBuf, String> {
    let env_override = std::env::var("BROSR_NODE").ok();
    let path_env = std::env::var_os("PATH");
    resolve_node_binary(
        root,
        env_override.as_deref(),
        SYSTEM_NODE_CANDIDATES,
        path_env.as_deref(),
    )
}

// host/cli.mjs lives in the bundle resources, and in the repository during a
// dev run. Each candidate is tried in the order a release needs it, so a bundle
// never reaches for the folder path of the machine that built it. The last
// resort names the bundle, because that path is the one a user can report.
fn project_root() -> PathBuf {
    if let Ok(given) = std::env::var("BROSR_ROOT") {
        if !given.is_empty() {
            return PathBuf::from(given);
        }
    }

    // A debug build belongs to the source tree. Prefer its host over the
    // staged copy beside the executable, because a frontend-only change does
    // not refresh that copy and can leave an older backend behind a newer UI.
    if cfg!(debug_assertions) {
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(root) = here.parent().and_then(|app| app.parent()) {
            if root.join("host").join("cli.mjs").exists() {
                return root.to_path_buf();
            }
        }
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = &exe_dir {
        // Windows and Linux keep the staged tree beside the executable. The
        // macOS bundle keeps it in Contents/Resources, one level above the
        // executable in Contents/MacOS. Check the side-by-side path first,
        // because that is the layout an installed Windows build uses.
        candidates.push(dir.join("resources"));
        let mac_resources = dir.join("..").join("Resources");
        candidates.push(mac_resources.join("resources"));
        candidates.push(mac_resources);
        // A bundle that strips the resource prefix still resolves here.
        candidates.push(dir.join("Resources").join("resources"));
        candidates.push(dir.join("Resources"));
    }
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = here.parent().and_then(|app| app.parent()) {
        candidates.push(root.to_path_buf());
    }

    for candidate in &candidates {
        if candidate.join("host").join("cli.mjs").exists() {
            return candidate.clone();
        }
    }

    exe_dir.map(|dir| dir.join("resources")).unwrap_or(here)
}

fn run_host(app: &AppHandle, args: Vec<String>) -> Result<Value, String> {
    let root = project_root();
    let cli = root.join("host").join("cli.mjs");
    if !cli.exists() {
        return Err(format!("The host CLI is missing at {}.", cli.display()));
    }

    // Room state lives outside the bundle. The bundle is sealed, so a write
    // inside it would break the signature on the next launch. A test run can
    // isolate two windows by pointing each process at its own folder.
    let state = match std::env::var("BROSR_STATE") {
        Ok(given) if !given.is_empty() => PathBuf::from(given),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|error| format!("There is no app data folder: {error}"))?,
    };
    let runtime = state.join("runtime");
    for dir in [&state, &runtime] {
        fs::create_dir_all(dir)
            .map_err(|error| format!("Could not make {}: {error}", dir.display()))?;
    }

    let mut command = Command::new(node_binary(&root)?);
    command
        .arg(&cli)
        .args(&args)
        .env("BROSR_STATE", &state)
        .env("BROSR_ZEN_RUNTIME", &runtime)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Node: {error}"))?;

    // The host reports each setup stage as one progress line on stderr. Each
    // line becomes an event, so the window moves before the command answers.
    // Every other line is kept for the error text.
    let mut errors: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            match line.strip_prefix("progress:") {
                Some(payload) => {
                    if let Ok(value) = serde_json::from_str::<Value>(payload) {
                        let _ = app.emit("brosr-progress", value);
                    }
                }
                None => {
                    if !line.trim().is_empty() {
                        errors.push(line);
                    }
                }
            }
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("The host did not finish: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| {
            let text = errors.join("\n");
            let text = text.trim();
            if text.is_empty() {
                "The host gave no answer.".to_string()
            } else {
                text.to_string()
            }
        })?;
    serde_json::from_str(line).map_err(|error| format!("The host answer did not parse: {error}"))
}

#[tauri::command]
async fn host(app: AppHandle, args: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_host(&app, args))
        .await
        .map_err(|error| error.to_string())?
}

fn main() {
    tauri::Builder::default()
        // The updater reads the signed latest.json on the GitHub release. The
        // process plugin restarts the app after an install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![host])
        .run(tauri::generate_context!())
        .expect("error while running Brosr");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "brosr-node-test-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn bundled_node_works_with_empty_path_and_no_system_node() {
        let root = scratch_dir("bundled");
        let bundled = root.join("node").join(BUNDLED_NODE_NAME);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"fake-node").unwrap();

        let got = resolve_node_binary(&root, None, &[], None);
        assert_eq!(got, Ok(bundled));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bundled_node_wins_over_system_and_path_node() {
        let root = scratch_dir("priority");
        let bundled = root.join("node").join(BUNDLED_NODE_NAME);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"bundled").unwrap();

        let path_dir = root.join("path-bin");
        fs::create_dir_all(&path_dir).unwrap();
        fs::write(path_dir.join(BUNDLED_NODE_NAME), b"path-node").unwrap();
        let path_env = OsString::from(path_dir.as_os_str());

        let got = resolve_node_binary(&root, None, &[], Some(&path_env));
        assert_eq!(got, Ok(bundled));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn env_override_wins_over_bundled_node() {
        let root = scratch_dir("override");
        let bundled = root.join("node").join(BUNDLED_NODE_NAME);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"bundled").unwrap();

        let got = resolve_node_binary(&root, Some("/custom/node"), &[], None);
        assert_eq!(got, Ok(PathBuf::from("/custom/node")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn falls_back_to_path_when_bundled_node_absent() {
        let root = scratch_dir("fallback");
        let path_dir = root.join("bin");
        fs::create_dir_all(&path_dir).unwrap();
        let path_node = path_dir.join(BUNDLED_NODE_NAME);
        fs::write(&path_node, b"path-node").unwrap();
        let path_env = OsString::from(path_dir.as_os_str());

        let got = resolve_node_binary(&root, None, &[], Some(&path_env));
        assert_eq!(got, Ok(path_node));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_clear_error_when_no_node_found() {
        let root = scratch_dir("missing");
        let got = resolve_node_binary(&root, None, &[], None);
        let err = got.expect_err("expected missing Node error");
        assert!(err.contains("Node.js was not found"));
        assert!(err.contains("BROSR_NODE"));

        let _ = fs::remove_dir_all(&root);
    }
}
