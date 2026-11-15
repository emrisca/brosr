// The app owns setup and the room lifecycle. It does no room work itself. Each
// command runs host/cli.mjs and returns the JSON line that file prints, so the
// browser and the app always agree on one source of truth.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

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
        for dir in path.split(':') {
            let candidate = PathBuf::from(dir).join("node");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    Err("Node.js was not found. Install Node 20 or later, or set BROSR_NODE.".to_string())
}

// The repository root holds host/cli.mjs. A bundle points at its resources, and
// a dev run falls back to the folder that compiled this file.
fn project_root() -> PathBuf {
    if let Ok(given) = std::env::var("BROSR_ROOT") {
        if !given.is_empty() {
            return PathBuf::from(given);
        }
    }
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = here.parent().and_then(|app| app.parent()) {
        if root.join("host").join("cli.mjs").exists() {
            return root.to_path_buf();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let resources = dir.join("..").join("Resources");
            if resources.join("host").join("cli.mjs").exists() {
                return resources;
            }
        }
    }
    here.parent()
        .and_then(|app| app.parent())
        .map(|root| root.to_path_buf())
        .unwrap_or(here)
}

fn run_host(app: &AppHandle, args: Vec<String>) -> Result<Value, String> {
    let cli = project_root().join("host").join("cli.mjs");
    if !cli.exists() {
        return Err(format!("The host CLI is missing at {}.", cli.display()));
    }
    let mut child = Command::new(node_binary()?)
        .arg(&cli)
        .args(&args)
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
