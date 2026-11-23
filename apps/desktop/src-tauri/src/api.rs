//! Local HTTP API for the Chrome extension and the Claude Code MCP server.
//!
//! Security model (see docs/PROPOSAL.md §12):
//! - bound to 127.0.0.1 only;
//! - `Host` must be 127.0.0.1/localhost on our port (blocks DNS rebinding);
//! - requests with an `Origin` header are refused unless that origin is allow-listed
//!   (websites can never call the API; the extension origin is added when it pairs);
//! - every route except `/v1/health` needs `Authorization: Bearer <token>`, compared in constant time;
//! - external clients can only *suggest*; nothing here edits or deletes tasks.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    error::{AppError, AppResult},
    model::{NewSuggestion, SuggestionStatus, TaskFilter, TaskStatus},
    repo::{code_projects, notes, projects, settings, suggestions, tasks},
    state::{API_PORT, AppState},
};

/// Settings key holding extra allowed `Origin` values (e.g. `chrome-extension://<id>`).
pub const ALLOWED_ORIGINS_KEY: &str = "api.allowedOrigins";
const MAX_BODY: usize = 256 * 1024;
/// Routes an unlisted extension origin may call: health (so an unpaired extension can tell that
/// Tether is running) and pairing (it proves itself with the code).
const PAIR_PATH: &str = "/v1/pair";

#[derive(Clone)]
pub struct ApiState {
    pub app: AppState,
    /// Called after a write so the UI can refresh.
    pub on_change: Arc<dyn Fn() + Send + Sync>,
    /// Bring the main window to the front.
    pub on_open: Arc<dyn Fn() + Send + Sync>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Invalid(_) | AppError::Json(_) => StatusCode::BAD_REQUEST,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Db(_) | AppError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            log::error!("api error: {self}");
        }
        (
            status,
            Json(json!({ "code": self.code(), "message": self.to_string() })),
        )
            .into_response()
    }
}

fn refuse(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "code": code, "message": message }))).into_response()
}

pub fn router(state: ApiState) -> Router {
    let protected = Router::new()
        .route(
            "/v1/suggestions",
            get(list_suggestions).post(create_suggestion),
        )
        .route("/v1/tasks", get(list_tasks))
        .route("/v1/tasks/{id}", get(get_task))
        .route("/v1/projects", get(list_projects))
        .route("/v1/open", post(open_app))
        .route("/v1/code-projects/resolve", post(resolve_code_project))
        .route("/v1/notes", get(list_notes))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));

    Router::new()
        .route("/v1/health", get(health))
        .route(PAIR_PATH, post(pair))
        .merge(protected)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            check_host_and_origin,
        ))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

pub async fn serve(state: ApiState) {
    match tokio::net::TcpListener::bind(("127.0.0.1", API_PORT)).await {
        Ok(listener) => {
            log::info!("api listening on 127.0.0.1:{API_PORT}");
            if let Err(e) = axum::serve(listener, router(state)).await {
                log::error!("api stopped: {e}");
            }
        }
        // Usually another copy of Tether or another program holds the port.
        Err(e) => log::error!("api could not bind 127.0.0.1:{API_PORT}: {e}"),
    }
}

/// Runs blocking SQLite work off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e)))?
}

// ---------- middleware ----------

fn host_ok(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let port = API_PORT.to_string();
    let Some((name, p)) = host.rsplit_once(':') else {
        return false;
    };
    p == port && (name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost"))
}

async fn check_host_and_origin(State(s): State<ApiState>, req: Request, next: Next) -> Response {
    if !host_ok(req.headers()) {
        return refuse(StatusCode::FORBIDDEN, "forbidden", "bad host");
    }
    if let Some(origin) = req.headers().get(header::ORIGIN)
        && req.uri().path() != PAIR_PATH
        && req.uri().path() != "/v1/health"
    {
        let origin = origin.to_str().unwrap_or("").to_string();
        let db = s.app.db.clone();
        let allowed = blocking(move || db.read(|c| settings::get(c, ALLOWED_ORIGINS_KEY)))
            .await
            .ok()
            .flatten()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        if !allowed.iter().any(|a| a.as_str() == Some(origin.as_str())) {
            return refuse(StatusCode::FORBIDDEN, "forbidden", "origin not allowed");
        }
    }
    next.run(req).await
}

async fn require_token(State(s): State<ApiState>, req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !s.app.token_matches(presented) {
        return refuse(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid token",
        );
    }
    next.run(req).await
}

// ---------- handlers ----------

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "app": "tether", "version": env!("CARGO_PKG_VERSION") }))
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
}

/// Pair a browser extension: the code shown in Tether's settings buys the token, and the
/// extension's origin is added to the allow-list. Only `chrome-extension://` origins may pair.
async fn pair(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> AppResult<Json<serde_json::Value>> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let id = origin.strip_prefix("chrome-extension://").unwrap_or("");
    if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
        return Err(AppError::invalid(
            "Only the Tether Chrome extension can pair.",
        ));
    }
    let token = s.app.redeem_pairing(&body.code)?;
    let db = s.app.db.clone();
    blocking(move || {
        db.write(|c| {
            let mut list: Vec<serde_json::Value> = settings::get(c, ALLOWED_ORIGINS_KEY)?
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            if !list.iter().any(|v| v.as_str() == Some(origin.as_str())) {
                list.push(serde_json::Value::from(origin.clone()));
            }
            settings::set(c, ALLOWED_ORIGINS_KEY, &serde_json::Value::Array(list))
        })
    })
    .await?;
    log::info!("browser extension paired");
    (s.on_change)();
    Ok(Json(json!({ "token": token })))
}

/// Find or register the Claude Code repo and return its context (mapped project, open tasks,
/// pending Claude suggestions). Writes only the code_projects row.
async fn resolve_code_project(
    State(s): State<ApiState>,
    Json(body): Json<code_projects::ResolveInput>,
) -> AppResult<Json<code_projects::ProjectContext>> {
    let db = s.app.db.clone();
    let ctx = blocking(move || db.write(|c| code_projects::context(c, &body))).await?;
    (s.on_change)(); // the folder list on the Projects screen may have a new entry
    Ok(Json(ctx))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteQuery {
    q: Option<String>,
    project_id: Option<String>,
    limit: Option<u32>,
}

async fn list_notes(
    State(s): State<ApiState>,
    Query(q): Query<NoteQuery>,
) -> AppResult<Json<Vec<crate::model::Note>>> {
    let filter = crate::model::NoteFilter {
        query: q.q,
        project_id: q.project_id,
        limit: Some(q.limit.unwrap_or(20).min(100)),
        ..Default::default()
    };
    let db = s.app.db.clone();
    Ok(Json(
        blocking(move || db.read(|c| notes::list(c, &filter))).await?,
    ))
}

async fn open_app(State(s): State<ApiState>) -> Json<serde_json::Value> {
    (s.on_open)();
    Json(json!({ "ok": true }))
}

async fn create_suggestion(
    State(s): State<ApiState>,
    Json(body): Json<NewSuggestion>,
) -> AppResult<(StatusCode, Json<crate::model::Suggestion>)> {
    let db = s.app.db.clone();
    let created = blocking(move || db.write(|c| suggestions::create(c, &body))).await?;
    (s.on_change)();
    Ok((StatusCode::CREATED, Json(created)))
}

#[derive(Deserialize)]
struct SuggestionQuery {
    status: Option<String>,
    limit: Option<u32>,
}

async fn list_suggestions(
    State(s): State<ApiState>,
    Query(q): Query<SuggestionQuery>,
) -> AppResult<Json<Vec<crate::model::Suggestion>>> {
    let status = match q.status.as_deref() {
        None | Some("") | Some("all") => None,
        Some(v) => {
            Some(SuggestionStatus::parse(v).ok_or_else(|| AppError::invalid("unknown status"))?)
        }
    };
    let db = s.app.db.clone();
    let out =
        blocking(move || db.read(|c| suggestions::list(c, status, q.limit.unwrap_or(50)))).await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskQuery {
    /// Comma-separated statuses.
    status: Option<String>,
    project_id: Option<String>,
    q: Option<String>,
    due_from: Option<String>,
    due_to: Option<String>,
    limit: Option<u32>,
}

async fn list_tasks(
    State(s): State<ApiState>,
    Query(q): Query<TaskQuery>,
) -> AppResult<Json<Vec<crate::model::Task>>> {
    let statuses = q
        .status
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| {
            TaskStatus::parse(v).ok_or_else(|| AppError::invalid(format!("unknown status {v}")))
        })
        .collect::<AppResult<Vec<_>>>()?;
    let filter = TaskFilter {
        statuses,
        project_id: q.project_id,
        query: q.q,
        due_from: q.due_from,
        due_to: q.due_to,
        top_level_only: true,
        limit: Some(q.limit.unwrap_or(50).min(200)),
        ..Default::default()
    };
    let db = s.app.db.clone();
    Ok(Json(
        blocking(move || db.read(|c| tasks::list(c, &filter))).await?,
    ))
}

async fn get_task(
    State(s): State<ApiState>,
    Path(id): Path<String>,
) -> AppResult<Json<crate::model::TaskDetail>> {
    let db = s.app.db.clone();
    Ok(Json(
        blocking(move || db.read(|c| tasks::detail(c, &id))).await?,
    ))
}

async fn list_projects(State(s): State<ApiState>) -> AppResult<Json<Vec<crate::model::Project>>> {
    let db = s.app.db.clone();
    Ok(Json(
        blocking(move || db.read(|c| projects::list(c, false))).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    fn setup() -> (Router, String, Arc<AtomicUsize>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tether-api-{}", ulid::Ulid::generate()));
        let app = AppState::open(&dir).unwrap();
        let token = app.token();
        let pair_app = app.clone();
        PAIR_APP.with(|p| *p.borrow_mut() = Some(pair_app));
        let changes = Arc::new(AtomicUsize::new(0));
        let c = changes.clone();
        let r = router(ApiState {
            app,
            on_change: Arc::new(move || {
                c.fetch_add(1, Ordering::SeqCst);
            }),
            on_open: Arc::new(|| {}),
        });
        (r, token, changes, dir)
    }

    thread_local! {
        static PAIR_APP: std::cell::RefCell<Option<AppState>> = const { std::cell::RefCell::new(None) };
    }

    const EXT: &str = "chrome-extension://elloobjbbdkoimibpcojhdgeocooibnl";

    #[tokio::test]
    async fn pairing_returns_token_and_allows_the_extension_origin() {
        let (r, token, _, dir) = setup();
        let app = PAIR_APP.with(|p| p.borrow().clone()).unwrap();
        let pair = |code: &str, origin: &str| {
            req("POST", "/v1/pair")
                .header(header::ORIGIN, origin)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "code": code }).to_string()))
                .unwrap()
        };
        // Before pairing, the extension origin is refused on protected routes.
        let list = || {
            req("GET", "/v1/projects")
                .header(header::ORIGIN, EXT)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(send(&r, list()).await.0, StatusCode::FORBIDDEN);

        let code = app.start_pairing();
        // A website cannot pair, even with the right code.
        assert_eq!(
            send(&r, pair(&code, "https://evil.example.com")).await.0,
            StatusCode::BAD_REQUEST
        );
        let (s, body) = send(&r, pair(&code, EXT)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(body["token"], token.as_str());
        assert_eq!(send(&r, list()).await.0, StatusCode::OK);
        // Single use.
        assert_eq!(send(&r, pair(&code, EXT)).await.0, StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn req(method: &str, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, format!("127.0.0.1:{API_PORT}"))
    }

    async fn send(r: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let res = r.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    fn suggestion_body() -> String {
        json!({
            "kind": "task",
            "origin": "chrome",
            "payload": { "title": "Follow up with Niamh", "dueDate": "2026-11-27" },
            "dedupeKey": "abc"
        })
        .to_string()
    }

    #[tokio::test]
    async fn health_is_open_but_host_checked() {
        let (r, _, _, dir) = setup();
        let (s, body) = send(&r, req("GET", "/v1/health").body(Body::empty()).unwrap()).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let rebinding = Request::builder()
            .uri("/v1/health")
            .header(header::HOST, "evil.example.com:47821")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&r, rebinding).await.0, StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn token_required_and_checked() {
        let (r, token, _, dir) = setup();
        let none = req("GET", "/v1/tasks").body(Body::empty()).unwrap();
        assert_eq!(send(&r, none).await.0, StatusCode::UNAUTHORIZED);
        let wrong = req("GET", "/v1/tasks")
            .header(header::AUTHORIZATION, "Bearer nope")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&r, wrong).await.0, StatusCode::UNAUTHORIZED);
        let ok = req("GET", "/v1/tasks")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&r, ok).await.0, StatusCode::OK);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn website_origin_is_refused_even_with_token() {
        let (r, token, _, dir) = setup();
        let res = req("POST", "/v1/suggestions")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::ORIGIN, "https://evil.example.com")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(suggestion_body()))
            .unwrap();
        assert_eq!(send(&r, res).await.0, StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn create_suggestion_is_idempotent_and_notifies() {
        let (r, token, changes, dir) = setup();
        let post = || {
            req("POST", "/v1/suggestions")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(suggestion_body()))
                .unwrap()
        };
        let (s1, b1) = send(&r, post()).await;
        let (s2, b2) = send(&r, post()).await;
        assert_eq!(s1, StatusCode::CREATED);
        assert_eq!(s2, StatusCode::CREATED);
        assert_eq!(b1["id"], b2["id"]);
        assert_eq!(b1["status"], "pending");
        assert_eq!(changes.load(Ordering::SeqCst), 2);

        let list = req("GET", "/v1/suggestions?status=pending")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let (_, body) = send(&r, list).await;
        assert_eq!(body.as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn bad_payload_is_400_with_message() {
        let (r, token, _, dir) = setup();
        let res = req("POST", "/v1/suggestions")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"kind":"task","origin":"chrome","payload":{"title":"  "}}).to_string(),
            ))
            .unwrap();
        let (s, body) = send(&r, res).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "invalid");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unknown_task_is_404() {
        let (r, token, _, dir) = setup();
        let res = req("GET", "/v1/tasks/missing")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&r, res).await.0, StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(dir);
    }
}
