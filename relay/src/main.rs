// The relay: one table per room, text and binary frames forwarded with their
// own opcode, and an optional capture file that records exactly what crossed
// this process. It parses neither kind, so a sealed frame stays sealed end to
// end and the relay can prove it by writing the bytes it saw.
//
// The wiring matches the spike relay: /health, /stats, /room, fixtures at the
// root, /assets and /media. Range requests are not served yet, so a video that
// seeks still needs the Node relay.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{
    collections::HashMap,
    env,
    io::Write,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::broadcast;

#[derive(Clone)]
struct Frame {
    from: u64,
    opcode: u8,
    bytes: Vec<u8>,
}

struct Room {
    tx: broadcast::Sender<Frame>,
}

struct App {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    next_id: AtomicU64,
    forwarded: AtomicU64,
    text: AtomicU64,
    binary: AtomicU64,
    capture: Option<PathBuf>,
    fixtures: PathBuf,
    assets: PathBuf,
    media: PathBuf,
}

impl App {
    fn from_env() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dir = |name: &str, fallback: &str| {
            env::var(name)
                .map(PathBuf::from)
                .unwrap_or_else(|_| root.join(fallback))
        };
        Self {
            rooms: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            forwarded: AtomicU64::new(0),
            text: AtomicU64::new(0),
            binary: AtomicU64::new(0),
            capture: env::var("RELAY_CAPTURE")
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            fixtures: dir("FIXTURES", "../spike/fixtures"),
            assets: dir("ASSETS", "../assets"),
            media: dir("MEDIA", "../spike/.runtime"),
        }
    }

    fn room(&self, name: &str) -> Arc<Room> {
        let mut rooms = self.rooms.lock().unwrap();
        rooms
            .entry(name.to_string())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(1024);
                Arc::new(Room { tx })
            })
            .clone()
    }

    // A proof reads this line to show what the relay saw. The capture stays off
    // unless RELAY_CAPTURE names a file.
    fn capture(&self, room: &str, opcode: u8, bytes: &[u8]) {
        let Some(path) = &self.capture else { return };
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let line = json!({
            "room": room,
            "opcode": opcode,
            "bytes": bytes.len(),
            "hex": hex,
        })
        .to_string();
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

async fn upgrade(
    ws: WebSocketUpgrade,
    State(app): State<Arc<App>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let room = query
        .get("room")
        .cloned()
        .unwrap_or_else(|| "default".to_string());
    ws.on_upgrade(move |socket| handle(socket, app, room))
}

async fn handle(socket: WebSocket, app: Arc<App>, room_name: String) {
    let id = app.next_id.fetch_add(1, Ordering::Relaxed);
    let room = app.room(&room_name);
    let mut rx = room.tx.subscribe();
    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let bytes = text.into_bytes();
                        app.text.fetch_add(1, Ordering::Relaxed);
                        app.capture(&room_name, 1, &bytes);
                        let _ = room.tx.send(Frame { from: id, opcode: 1, bytes });
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        app.binary.fetch_add(1, Ordering::Relaxed);
                        app.capture(&room_name, 2, &bytes);
                        let _ = room.tx.send(Frame { from: id, opcode: 2, bytes });
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = sink.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Ok(frame) if frame.from != id => {
                        let message = if frame.opcode == 1 {
                            Message::Text(String::from_utf8_lossy(&frame.bytes).into_owned())
                        } else {
                            Message::Binary(frame.bytes)
                        };
                        if sink.send(message).await.is_err() {
                            break;
                        }
                        app.forwarded.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn stats(State(app): State<Arc<App>>) -> impl IntoResponse {
    let rooms: HashMap<String, usize> = app
        .rooms
        .lock()
        .unwrap()
        .iter()
        .map(|(name, room)| (name.clone(), room.tx.receiver_count()))
        .collect();
    Json(json!({
        "rooms": rooms,
        "forwarded": app.forwarded.load(Ordering::Relaxed),
        "text": app.text.load(Ordering::Relaxed),
        "binary": app.binary.load(Ordering::Relaxed),
    }))
}

async fn files(State(app): State<Arc<App>>, uri: Uri) -> Response {
    let path = uri.path();
    let (root, rest) = if let Some(rest) = path.strip_prefix("/media/") {
        (&app.media, rest)
    } else if let Some(rest) = path.strip_prefix("/assets/") {
        (&app.assets, rest)
    } else {
        (&app.fixtures, path.trim_start_matches('/'))
    };
    let relative = if rest.is_empty() { "sync.html" } else { rest };
    // A traversal attempt is refused before it reaches the disk.
    if Path::new(relative)
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let file = root.join(relative);
    let kind = match file.extension().and_then(|value| value.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, kind),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[tokio::main]
async fn main() {
    let app = Arc::new(App::from_env());
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/stats", get(stats))
        .route("/room", get(upgrade))
        .fallback(files)
        .with_state(app);

    let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("HOST or PORT is not an address");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|error| {
            eprintln!("[relay] cannot listen on {addr}: {error}");
            std::process::exit(1);
        });
    println!("[relay] http://{addr} ws://{addr}/room");
    if let Err(error) = axum::serve(listener, router).await {
        eprintln!("[relay] {error}");
        std::process::exit(1);
    }
}
