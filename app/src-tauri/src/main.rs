// The app owns setup and the room lifecycle. It does no room work itself. Each
// command runs host/cli.mjs and returns the JSON line that file prints, so the
// browser and the app always agree on one source of truth.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

// A window opened from Finder inherits a short PATH, so the usual install
// prefixes are checked before the inherited one.
fn node_binary() -> Result<PathBuf, String> {
    if let Ok(given) = std::env::var("BROSR_NODE") {
        if !given.is_empty() {
            return Ok(PathBuf::from(given));
        }
    }
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        if Path::new(candidate).exists() {
            return Ok(PathBuf::from(candidate));
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        // Windows separates PATH entries with `;`, and its executable carries
        // the `.exe` suffix. `split_paths` handles both platforms, and trying
        // both names keeps a Windows shell and a Unix build on one path.
        for dir in std::env::split_paths(&path) {
            for name in ["node", "node.exe"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    Err("Node.js was not found. Install Node 20 or later, or set BROSR_NODE.".to_string())
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

    let resources = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("..").join("Resources")));

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(resources) = &resources {
        // The bundler keeps the path relative to src-tauri, so a staged tree
        // lands under resources/. A mapping that strips the prefix is also
        // accepted, and both are checked.
        candidates.push(resources.join("resources"));
        candidates.push(resources.clone());
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

    resources.unwrap_or(here)
}

fn run_host(app: &AppHandle, args: Vec<String>) -> Result<Value, String> {
    let cli = project_root().join("host").join("cli.mjs");
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

    let mut child = Command::new(node_binary()?)
        .arg(&cli)
        .args(&args)
        .env("BROSR_STATE", &state)
        .env("BROSR_ZEN_RUNTIME", &runtime)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
