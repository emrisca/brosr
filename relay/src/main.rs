// The relay: one table per room, text and binary frames forwarded with their
// own opcode, and an optional capture file that records exactly what crossed
// this process. It parses neither kind, so a sealed frame stays sealed end to
// end and the relay can prove it by writing the bytes it saw.
//
// Routes match the Node relay in spike/relay.js:
// - /health, /stats, /status
// - /room (WebSocket fan-out with room, role and peer tracking)
// - /docs and /docs/:id (host document library for canvas and notes)
// - /media/* (byte-range streaming for seeking video clips)
// - /assets/*, landing apps (/, /canvas, /notes, /chess, /docs-client.js) and fixtures.

use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Path as AxumPath, Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    io::{SeekFrom, Write},
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    sync::broadcast,
};

const DOC_MAX: usize = 4 * 1024 * 1024;

#[derive(Clone)]
struct Frame {
    from: u64,
    opcode: u8,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Host,
    Peer,
    Panel,
    Cursor,
}

impl Role {
    fn from_param(value: Option<&str>) -> Self {
        match value {
            Some("host") => Self::Host,
            Some("panel") => Self::Panel,
            Some("cursor") => Self::Cursor,
            _ => Self::Peer,
        }
    }
}

struct Member {
    role: Role,
    peer: String,
}

struct Room {
    tx: broadcast::Sender<Frame>,
    members: HashMap<u64, Member>,
}

struct App {
    rooms: Mutex<HashMap<String, Room>>,
    next_id: AtomicU64,
    doc_write_seq: AtomicU64,
    forwarded: AtomicU64,
    text: AtomicU64,
    binary: AtomicU64,
    started: Instant,
    capture: Option<PathBuf>,
    fixtures_explicit: bool,
    fixtures: PathBuf,
    landing: PathBuf,
    assets: PathBuf,
    media: PathBuf,
    docs_dir: PathBuf,
    docs_token: String,
}

impl App {
    fn from_env() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dir = |name: &str, fallback: &str| {
            env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(fallback))
        };
        let has_env = |name: &str| {
            env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .is_some()
        };
        let fixtures_explicit = has_env("FIXTURES") && !has_env("LANDING");
        Self {
            rooms: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            doc_write_seq: AtomicU64::new(1),
            forwarded: AtomicU64::new(0),
            text: AtomicU64::new(0),
            binary: AtomicU64::new(0),
            started: Instant::now(),
            capture: env::var("RELAY_CAPTURE")
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            fixtures_explicit,
            fixtures: dir("FIXTURES", "../spike/fixtures"),
            landing: dir("LANDING", "../landing"),
            assets: dir("ASSETS", "../assets"),
            media: dir("MEDIA", "../spike/.runtime"),
            docs_dir: dir("BROSR_DOCS_DIR", "../spike/.runtime/docs"),
            docs_token: env::var("BROSR_DOCS_TOKEN").unwrap_or_default(),
        }
    }

    fn join_room(
        &self,
        name: &str,
        id: u64,
        role: Role,
        peer: String,
    ) -> (broadcast::Sender<Frame>, broadcast::Receiver<Frame>) {
        let mut rooms = self.rooms.lock().unwrap();
        let room = rooms.entry(name.to_string()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(1024);
            Room {
                tx,
                members: HashMap::new(),
            }
        });
        room.members.insert(id, Member { role, peer });
        let tx = room.tx.clone();
        let rx = room.tx.subscribe();
        (tx, rx)
    }

    fn leave_room(&self, name: &str, id: u64) {
        let mut rooms = self.rooms.lock().unwrap();
        let remove_room = match rooms.get_mut(name) {
            Some(room) => {
                room.members.remove(&id);
                room.members.is_empty()
            }
            None => false,
        };
        if remove_room {
            rooms.remove(name);
        }
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

// Dropping this guard always removes the client from the room and evicts an
// empty room from the table, even if the task exits early.
struct MemberGuard {
    app: Arc<App>,
    room: String,
    id: u64,
}

impl Drop for MemberGuard {
    fn drop(&mut self) {
        self.app.leave_room(&self.room, self.id);
    }
}

async fn upgrade(
    ws: WebSocketUpgrade,
    State(app): State<Arc<App>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let room = query
        .get("room")
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| "default".to_string());
    let role = Role::from_param(query.get("role").map(String::as_str));
    let peer = query.get("peer").cloned().unwrap_or_default();
    ws.on_upgrade(move |socket| handle(socket, app, room, role, peer))
}

async fn handle(socket: WebSocket, app: Arc<App>, room_name: String, role: Role, peer: String) {
    let id = app.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = app.join_room(&room_name, id, role, peer);
    let _guard = MemberGuard {
        app: app.clone(),
        room: room_name.clone(),
        id,
    };
    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let bytes = text.into_bytes();
                        app.text.fetch_add(1, Ordering::Relaxed);
                        app.capture(&room_name, 1, &bytes);
                        let _ = tx.send(Frame { from: id, opcode: 1, bytes });
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        app.binary.fetch_add(1, Ordering::Relaxed);
                        app.capture(&room_name, 2, &bytes);
                        let _ = tx.send(Frame { from: id, opcode: 2, bytes });
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
        .map(|(name, room)| (name.clone(), room.members.len()))
        .collect();
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "rooms": rooms,
            "forwarded": app.forwarded.load(Ordering::Relaxed),
            "text": app.text.load(Ordering::Relaxed),
            "binary": app.binary.load(Ordering::Relaxed),
        })),
    )
}

// The app and landing page ask how many apps and people are in a room and
// whether the host is one of them. Panel and cursor sockets stay out of both
// counts so a pointer surface or control channel never inflates the room.
async fn status(
    State(app): State<Arc<App>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let room_name = query.get("room").cloned().unwrap_or_default();
    let (peers, hosts, people, rooms) = {
        let guard = app.rooms.lock().unwrap();
        let mut peers = 0usize;
        let mut hosts = 0usize;
        let mut anonymous = 0usize;
        let mut seen = HashSet::new();
        if !room_name.is_empty() {
            if let Some(room) = guard.get(&room_name) {
                for member in room.members.values() {
                    if member.role == Role::Panel || member.role == Role::Cursor {
                        continue;
                    }
                    peers += 1;
                    if member.role == Role::Host {
                        hosts += 1;
                    }
                    if member.peer.is_empty() {
                        anonymous += 1;
                        seen.insert(format!("socket:{anonymous}"));
                    } else {
                        seen.insert(member.peer.clone());
                    }
                }
            }
        }
        let rooms: HashMap<String, usize> = guard
            .iter()
            .map(|(name, room)| (name.clone(), room.members.len()))
            .collect();
        (peers, hosts, seen.len(), rooms)
    };
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        Json(json!({
            "room": room_name,
            "peers": peers,
            "hosts": hosts,
            "people": people,
            "rooms": rooms,
            "uptime": app.started.elapsed().as_secs(),
        })),
    )
}

// ---------------------------------------------------------------------------
// Documents (/docs and /docs/:id)

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().map_or(false, |v4| v4.is_loopback())
        }
    }
}

fn docs_allowed(app: &App, addr: SocketAddr, query: &HashMap<String, String>) -> bool {
    if !app.docs_token.is_empty() {
        return query
            .get("token")
            .map(|token| constant_time_eq(token.as_bytes(), app.docs_token.as_bytes()))
            .unwrap_or(false);
    }
    is_loopback(addr.ip())
}

fn docs_answer(status: StatusCode, body: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

fn valid_doc_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 40 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_doc_kind(kind: &str) -> bool {
    kind == "canvas" || kind == "note"
}

fn doc_label(value: Option<&Value>) -> String {
    let raw = value.and_then(Value::as_str).unwrap_or("");
    let cleaned: String = raw
        .chars()
        .map(|ch| if (ch as u32) < 0x20 { ' ' } else { ch })
        .collect();
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(60)
        .collect()
}

fn doc_text(html: &str) -> String {
    let mut stripped = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                stripped.push(' ');
            }
            '>' => {
                in_tag = false;
            }
            _ if !in_tag => stripped.push(ch),
            _ => {}
        }
    }
    let decoded = stripped.replace("&nbsp;", " ").replace("&amp;", "&");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn doc_preview(doc: &Value) -> String {
    if doc.get("kind").and_then(Value::as_str) == Some("note") {
        let body = doc.get("body").and_then(Value::as_str).unwrap_or("");
        return doc_text(body).chars().take(140).collect();
    }
    let mut count = 0usize;
    if let Some(layers) = doc
        .get("body")
        .and_then(|body| body.get("layers"))
        .and_then(Value::as_array)
    {
        for layer in layers {
            if let Some(strokes) = layer.get("strokes").and_then(Value::as_array) {
                count += strokes.len();
            }
        }
    }
    if count == 1 {
        "1 stroke".to_string()
    } else {
        format!("{count} strokes")
    }
}

fn doc_file(app: &App, id: &str) -> Result<PathBuf, std::io::Error> {
    std::fs::create_dir_all(&app.docs_dir)?;
    Ok(app.docs_dir.join(format!("{id}.json")))
}

fn doc_read(app: &App, id: &str) -> Option<Value> {
    if !valid_doc_id(id) {
        return None;
    }
    let path = app.docs_dir.join(format!("{id}.json"));
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn doc_at(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(num)) => num.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0),
        Some(Value::String(text)) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn doc_list(app: &App, kind_filter: &str) -> Vec<Value> {
    let mut entries: Vec<(f64, Value)> = Vec::new();
    let Ok(dir) = std::fs::read_dir(&app.docs_dir) else {
        return Vec::new();
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let Some(doc) = doc_read(app, id) else {
            continue;
        };
        let Some(kind) = doc.get("kind").and_then(Value::as_str) else {
            continue;
        };
        if !valid_doc_kind(kind) {
            continue;
        }
        if !kind_filter.is_empty() && kind != kind_filter {
            continue;
        }
        let label = doc_label(doc.get("name"));
        let at = doc_at(doc.get("at"));
        let hidden = doc.get("hidden").and_then(Value::as_bool) == Some(true);
        let stored = doc.get("stored").and_then(Value::as_bool) != Some(false);
        let at_json = if at.fract() == 0.0 && at >= 0.0 && at <= u64::MAX as f64 {
            json!(at as u64)
        } else {
            json!(at)
        };
        entries.push((
            at,
            json!({
                "id": doc.get("id").and_then(Value::as_str).unwrap_or(id),
                "kind": kind,
                "name": if label.is_empty() { "Untitled".to_string() } else { label },
                "at": at_json,
                "hidden": hidden,
                "stored": stored,
                "preview": doc_preview(&doc),
            }),
        ));
    }
    entries.sort_by(|a, b| b.0.total_cmp(&a.0));
    entries.into_iter().map(|(_, item)| item).collect()
}

fn doc_write(app: &App, id: &str, doc: &Value) -> Result<(), std::io::Error> {
    let file = doc_file(app, id)?;
    let seq = app.doc_write_seq.fetch_add(1, Ordering::Relaxed);
    let tmp = file.with_extension(format!("json.{}.{}.tmp", std::process::id(), seq));
    let payload = serde_json::to_vec(doc)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        let mut handle = options.open(&tmp)?;
        handle.write_all(&payload)?;
        handle.sync_all()?;
    }
    std::fs::rename(&tmp, &file)?;
    Ok(())
}

async fn docs_root(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    method: Method,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !docs_allowed(&app, addr, &query) {
        return docs_answer(StatusCode::FORBIDDEN, json!({ "ok": false, "error": "forbidden" }));
    }
    if method == Method::GET {
        let kind = query.get("kind").map(String::as_str).unwrap_or("");
        return docs_answer(StatusCode::OK, json!({ "ok": true, "docs": doc_list(&app, kind) }));
    }
    docs_answer(StatusCode::METHOD_NOT_ALLOWED, json!({ "ok": false, "error": "method" }))
}

async fn docs_item(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    method: Method,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
    body: Body,
) -> Response {
    if !docs_allowed(&app, addr, &query) {
        return docs_answer(StatusCode::FORBIDDEN, json!({ "ok": false, "error": "forbidden" }));
    }
    if method == Method::GET {
        return match doc_read(&app, &id) {
            Some(doc) => docs_answer(StatusCode::OK, json!({ "ok": true, "doc": doc })),
            None => docs_answer(StatusCode::NOT_FOUND, json!({ "ok": false, "error": "not found" })),
        };
    }
    if method == Method::PUT {
        if !valid_doc_id(&id) {
            return docs_answer(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "bad id" }));
        }
        let Ok(bytes) = to_bytes(body, DOC_MAX).await else {
            return docs_answer(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "bad body" }));
        };
        let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(&bytes) else {
            return docs_answer(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "bad body" }));
        };
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .filter(|k| valid_doc_kind(k))
            .unwrap_or("note");
        let label = doc_label(obj.get("name"));
        let at_raw = doc_at(obj.get("at"));
        let at_json = if at_raw != 0.0 {
            if at_raw.fract() == 0.0 && at_raw >= 0.0 && at_raw <= u64::MAX as f64 {
                json!(at_raw as u64)
            } else {
                json!(at_raw)
            }
        } else {
            json!(now_millis())
        };
        let mut doc = Map::new();
        doc.insert("id".to_string(), Value::String(id.clone()));
        doc.insert("kind".to_string(), Value::String(kind.to_string()));
        doc.insert(
            "name".to_string(),
            Value::String(if label.is_empty() {
                "Untitled".to_string()
            } else {
                label
            }),
        );
        doc.insert("at".to_string(), at_json);
        doc.insert(
            "hidden".to_string(),
            Value::Bool(obj.get("hidden").and_then(Value::as_bool) == Some(true)),
        );
        doc.insert(
            "stored".to_string(),
            Value::Bool(obj.get("stored").and_then(Value::as_bool) != Some(false)),
        );
        doc.insert(
            "body".to_string(),
            obj.get("body").cloned().unwrap_or(Value::Null),
        );
        doc.insert(
            "crdt".to_string(),
            match obj.get("crdt") {
                Some(value @ Value::Object(_)) => value.clone(),
                _ => Value::Null,
            },
        );
        let value = Value::Object(doc);
        if doc_write(&app, &id, &value).is_err() {
            return docs_answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "ok": false, "error": "write failed" }),
            );
        }
        return docs_answer(StatusCode::OK, json!({ "ok": true, "id": id }));
    }
    if method == Method::DELETE {
        if !valid_doc_id(&id) {
            return docs_answer(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "bad id" }));
        }
        let path = app.docs_dir.join(format!("{id}.json"));
        let _ = std::fs::remove_file(path);
        return docs_answer(StatusCode::OK, json!({ "ok": true }));
    }
    docs_answer(StatusCode::METHOD_NOT_ALLOWED, json!({ "ok": false, "error": "method" }))
}

// ---------------------------------------------------------------------------
// Static files & byte-range media

fn safe_relative(relative: &str) -> bool {
    !Path::new(relative)
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
}

fn mime_for(file: &Path) -> &'static str {
    // A browser refuses a stylesheet, a module or an icon that arrives with
    // the wrong type, so every extension the pages ship carries its own.
    match file.extension().and_then(|value| value.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("webm") => "video/webm",
        Some("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }
}

enum ByteRange {
    Valid(u64, u64),
    Unsatisfiable,
}

fn parse_byte_range(header_value: &str, size: u64) -> Option<ByteRange> {
    let spec = header_value.strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split_once('-')?;
    if start_str.is_empty() && end_str.is_empty() {
        return Some(ByteRange::Unsatisfiable);
    }
    if size == 0 {
        return Some(ByteRange::Unsatisfiable);
    }
    if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 {
            return Some(ByteRange::Unsatisfiable);
        }
        let start = size.saturating_sub(suffix);
        return Some(ByteRange::Valid(start, size - 1));
    }
    let start: u64 = start_str.parse().ok()?;
    let end = if end_str.is_empty() {
        size - 1
    } else {
        end_str.parse::<u64>().ok()?.min(size - 1)
    };
    if start >= size || end < start {
        return Some(ByteRange::Unsatisfiable);
    }
    Some(ByteRange::Valid(start, end))
}

async fn serve_media(file: &Path, headers: &HeaderMap) -> Response {
    let Ok(mut handle) = tokio::fs::File::open(file).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let Ok(meta) = handle.metadata().await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !meta.is_file() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let size = meta.len();
    let kind = match file.extension().and_then(|value| value.to_str()) {
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        _ => "video/webm",
    };
    if let Some(raw_range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(parsed) = parse_byte_range(raw_range.trim(), size) {
            match parsed {
                ByteRange::Unsatisfiable => {
                    return (
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        [(header::CONTENT_RANGE, format!("bytes */{size}"))],
                    )
                        .into_response();
                }
                ByteRange::Valid(start, end) => {
                    let length = end - start + 1;
                    if handle.seek(SeekFrom::Start(start)).await.is_err() {
                        return (StatusCode::INTERNAL_SERVER_ERROR, "seek failed").into_response();
                    }
                    let mut buf = Vec::with_capacity(length.min(1024 * 1024) as usize);
                    if handle.take(length).read_to_end(&mut buf).await.is_err() {
                        return (StatusCode::INTERNAL_SERVER_ERROR, "read failed").into_response();
                    }
                    return (
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (header::CONTENT_TYPE, kind.to_string()),
                            (header::ACCEPT_RANGES, "bytes".to_string()),
                            (
                                header::CONTENT_RANGE,
                                format!("bytes {start}-{end}/{size}"),
                            ),
                            (header::CONTENT_LENGTH, buf.len().to_string()),
                            (header::CACHE_CONTROL, "no-store".to_string()),
                        ],
                        buf,
                    )
                        .into_response();
                }
            }
        }
    }
    let mut buf = Vec::new();
    if handle.read_to_end(&mut buf).await.is_err() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, kind.to_string()),
            (header::ACCEPT_RANGES, "bytes".to_string()),
            (header::CONTENT_LENGTH, size.to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        buf,
    )
        .into_response()
}

fn landing_target(path: &str) -> Option<String> {
    match path {
        "/" | "/index.html" => Some("index.html".to_string()),
        "/landing.css" => Some("landing.css".to_string()),
        "/favicon.svg" => Some("favicon.svg".to_string()),
        "/docs-client.js" => Some("docs-client.js".to_string()),
        _ => {
            for app_dir in ["canvas", "notes", "chess"] {
                let exact = format!("/{app_dir}");
                let slash = format!("/{app_dir}/");
                if path == exact || path == slash {
                    return Some(format!("{app_dir}/index.html"));
                }
                if let Some(rest) = path.strip_prefix(&slash) {
                    return Some(format!("{app_dir}/{rest}"));
                }
            }
            None
        }
    }
}

async fn serve_file(file: &Path) -> Option<Response> {
    let bytes = tokio::fs::read(file).await.ok()?;
    let kind = mime_for(file);
    Some(
        (
            [
                (header::CONTENT_TYPE, kind),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
    )
}

async fn files(State(app): State<Arc<App>>, headers: HeaderMap, uri: Uri) -> Response {
    let path = uri.path();

    if let Some(rest) = path.strip_prefix("/media/") {
        if rest.is_empty() || !safe_relative(rest) {
            return (StatusCode::FORBIDDEN, "forbidden").into_response();
        }
        return serve_media(&app.media.join(rest), &headers).await;
    }

    if let Some(rest) = path.strip_prefix("/assets/") {
        if rest.is_empty() || !safe_relative(rest) {
            return (StatusCode::FORBIDDEN, "forbidden").into_response();
        }
        return serve_file(&app.assets.join(rest))
            .await
            .unwrap_or_else(|| (StatusCode::NOT_FOUND, "not found").into_response());
    }

    let trimmed = path.trim_start_matches('/');
    if !safe_relative(trimmed) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    if app.fixtures_explicit {
        // Explicit FIXTURES (used by check-two-instance and check-relay-files)
        // resolves against FIXTURES first and falls back to landing.
        let candidate = if trimmed.is_empty() {
            let sync = app.fixtures.join("sync.html");
            if sync.is_file() {
                sync
            } else {
                app.fixtures.join("index.html")
            }
        } else {
            let direct = app.fixtures.join(trimmed);
            if direct.is_dir() {
                direct.join("index.html")
            } else {
                direct
            }
        };
        if let Some(response) = serve_file(&candidate).await {
            return response;
        }
        if let Some(target) = landing_target(path) {
            if safe_relative(&target) {
                if let Some(response) = serve_file(&app.landing.join(target)).await {
                    return response;
                }
            }
        }
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }

    if let Some(target) = landing_target(path) {
        if !safe_relative(&target) {
            return (StatusCode::FORBIDDEN, "forbidden").into_response();
        }
        return serve_file(&app.landing.join(target))
            .await
            .unwrap_or_else(|| (StatusCode::NOT_FOUND, "not found").into_response());
    }

    let relative = if trimmed.is_empty() { "sync.html" } else { trimmed };
    serve_file(&app.fixtures.join(relative))
        .await
        .unwrap_or_else(|| (StatusCode::NOT_FOUND, "not found").into_response())
}

fn build_router(app: Arc<App>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/stats", get(stats))
        .route("/status", get(status))
        .route("/room", get(upgrade))
        .route("/docs", any(docs_root))
        .route(
            "/docs/:id",
            any(docs_item).layer(DefaultBodyLimit::disable()),
        )
        .fallback(files)
        .with_state(app)
}

#[tokio::main]
async fn main() {
    let app = Arc::new(App::from_env());
    let router = build_router(app);

    let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("HOST or PORT is not an address");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|error| {
            eprintln!("[relay] cannot listen on {addr}: {error}");
            std::process::exit(1);
        });
    println!("[relay] http://{addr} ws://{addr}/room");
    if let Err(error) = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        eprintln!("[relay] {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_app(temp: &Path, docs_token: &str) -> Arc<App> {
        let fixtures = temp.join("fixtures");
        let landing = temp.join("landing");
        let assets = temp.join("assets");
        let media = temp.join("media");
        let docs_dir = temp.join("docs");
        for dir in [&fixtures, &landing, &assets, &media, &docs_dir] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::create_dir_all(landing.join("canvas")).unwrap();
        std::fs::write(landing.join("index.html"), "<html>landing</html>").unwrap();
        std::fs::write(landing.join("landing.css"), "body { color: red; }").unwrap();
        std::fs::write(landing.join("canvas/index.html"), "<html>canvas</html>").unwrap();
        std::fs::write(fixtures.join("board.html"), "<html>board</html>").unwrap();
        std::fs::write(media.join("clip.webm"), vec![42u8; 256]).unwrap();

        Arc::new(App {
            rooms: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            doc_write_seq: AtomicU64::new(1),
            forwarded: AtomicU64::new(0),
            text: AtomicU64::new(0),
            binary: AtomicU64::new(0),
            started: Instant::now(),
            capture: None,
            fixtures_explicit: false,
            fixtures,
            landing,
            assets,
            media,
            docs_dir,
            docs_token: docs_token.to_string(),
        })
    }

    async fn spawn_server(app: Arc<App>) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = build_router(app);
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        addr
    }

    async fn http_request(
        addr: SocketAddr,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> (u16, HashMap<String, String>, Vec<u8>) {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        for (name, value) in headers {
            req.push_str(&format!("{name}: {value}\r\n"));
        }
        if !body.is_empty() {
            req.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        req.push_str("\r\n");
        tokio::io::AsyncWriteExt::write_all(&mut stream, req.as_bytes())
            .await
            .unwrap();
        if !body.is_empty() {
            tokio::io::AsyncWriteExt::write_all(&mut stream, body)
                .await
                .unwrap();
        }
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let head = std::str::from_utf8(&raw[..split]).unwrap();
        let mut lines = head.lines();
        let status: u16 = lines
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let mut hdrs = HashMap::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                hdrs.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
        (status, hdrs, raw[split + 4..].to_vec())
    }

    #[test]
    fn room_join_leave_evicts_empty_room_and_counts_roles() {
        let temp = std::env::temp_dir().join(format!("brosr-relay-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let app = test_app(&temp, "");

        let _ = app.join_room("alpha", 1, Role::Host, "host-1".into());
        let _ = app.join_room("alpha", 2, Role::Peer, "guest-1".into());
        let _ = app.join_room("alpha", 3, Role::Peer, "guest-1".into());
        let _ = app.join_room("alpha", 4, Role::Panel, "host-1".into());
        let _ = app.join_room("alpha", 5, Role::Cursor, String::new());
        assert_eq!(app.rooms.lock().unwrap().get("alpha").unwrap().members.len(), 5);

        for id in 1..=5 {
            app.leave_room("alpha", id);
        }
        assert!(!app.rooms.lock().unwrap().contains_key("alpha"));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn byte_range_parser_handles_partial_suffix_and_invalid() {
        assert!(matches!(
            parse_byte_range("bytes=0-99", 1024),
            Some(ByteRange::Valid(0, 99))
        ));
        assert!(matches!(
            parse_byte_range("bytes=100-", 256),
            Some(ByteRange::Valid(100, 255))
        ));
        assert!(matches!(
            parse_byte_range("bytes=-50", 256),
            Some(ByteRange::Valid(206, 255))
        ));
        assert!(matches!(
            parse_byte_range("bytes=300-400", 256),
            Some(ByteRange::Unsatisfiable)
        ));
        assert!(matches!(
            parse_byte_range("bytes=10-5", 256),
            Some(ByteRange::Unsatisfiable)
        ));
    }

    #[test]
    fn doc_id_and_preview_validation() {
        assert!(valid_doc_id("note-1"));
        assert!(valid_doc_id("d-abc-123"));
        assert!(!valid_doc_id(""));
        assert!(!valid_doc_id("-bad"));
        assert!(!valid_doc_id("../escape"));
        assert!(!valid_doc_id("Upper"));
        assert_eq!(
            doc_preview(&json!({ "kind": "note", "body": "<p>Hi &amp; bye&nbsp;!</p>" })),
            "Hi & bye !"
        );
        assert_eq!(
            doc_preview(&json!({ "kind": "canvas", "body": { "layers": [{ "strokes": [1] }] } })),
            "1 stroke"
        );
        assert_eq!(
            doc_preview(&json!({ "kind": "canvas", "body": { "layers": [{ "strokes": [1, 2] }] } })),
            "2 strokes"
        );
    }

    #[tokio::test]
    async fn http_status_media_ranges_landing_and_docs_work() {
        let temp = std::env::temp_dir().join(format!("brosr-relay-http-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let app = test_app(&temp, "tok-42");
        let _ = app.join_room("r1", 1, Role::Host, "h1".into());
        let _ = app.join_room("r1", 2, Role::Peer, "g1".into());
        let _ = app.join_room("r1", 3, Role::Cursor, String::new());
        let _ = app.join_room("r1", 4, Role::Panel, "h1".into());
        let addr = spawn_server(app).await;

        let (code, hdrs, body) = http_request(addr, "GET", "/status?room=r1", &[], &[]).await;
        assert_eq!(code, 200);
        assert_eq!(hdrs.get("access-control-allow-origin").map(String::as_str), Some("*"));
        let status: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status["peers"], 2);
        assert_eq!(status["hosts"], 1);
        assert_eq!(status["people"], 2);

        let (code, hdrs, body) = http_request(
            addr,
            "GET",
            "/media/clip.webm",
            &[("Range", "bytes=10-29")],
            &[],
        )
        .await;
        assert_eq!(code, 206);
        assert_eq!(hdrs.get("content-range").map(String::as_str), Some("bytes 10-29/256"));
        assert_eq!(body.len(), 20);

        let (code, _, _) = http_request(
            addr,
            "GET",
            "/media/clip.webm",
            &[("Range", "bytes=500-600")],
            &[],
        )
        .await;
        assert_eq!(code, 416);

        let (code, hdrs, _) = http_request(addr, "GET", "/canvas", &[], &[]).await;
        assert_eq!(code, 200);
        assert!(hdrs["content-type"].starts_with("text/html"));

        let (code, _, _) = http_request(addr, "GET", "/docs", &[], &[]).await;
        assert_eq!(code, 403);

        let payload = br#"{"kind":"note","name":"Hello","at":500,"body":"<b>World</b>"}"#;
        let (code, _, _) = http_request(
            addr,
            "PUT",
            "/docs/n1?token=tok-42",
            &[("Content-Type", "application/json")],
            payload,
        )
        .await;
        assert_eq!(code, 200);

        let (code, _, body) = http_request(addr, "GET", "/docs?token=tok-42", &[], &[]).await;
        assert_eq!(code, 200);
        let listed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(listed["docs"][0]["id"], "n1");
        assert_eq!(listed["docs"][0]["preview"], "World");

        let (code, _, _) =
            http_request(addr, "DELETE", "/docs/..%2Fbad?token=tok-42", &[], &[]).await;
        assert_eq!(code, 400);

        let (code, _, _) = http_request(addr, "DELETE", "/docs/n1?token=tok-42", &[], &[]).await;
        assert_eq!(code, 200);

        let _ = std::fs::remove_dir_all(&temp);
    }
}
