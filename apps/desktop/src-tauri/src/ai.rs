//! Optional local AI through Ollama on this PC. Off by default; every result is a suggestion the
//! user confirms. Only loopback Ollama URLs are accepted, so no text ever leaves the machine.

use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    error::{AppError, AppResult},
    model::{clean_date, clean_title},
    repo::settings,
};

pub const SETTINGS_KEY: &str = "ai";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub enabled: bool,
    pub url: String,
    pub model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            url: "http://127.0.0.1:11434".into(),
            model: "qwen2.5:1.5b".into(),
        }
    }
}

impl AiSettings {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        Ok(settings::get(conn, SETTINGS_KEY)?
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default())
    }

    pub fn validate(&self) -> AppResult<()> {
        let u = self.url.trim().trim_end_matches('/');
        let local = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"]
            .iter()
            .any(|p| {
                u.starts_with(p)
                    && u[p.len()..].chars().all(|c| c.is_ascii_digit())
                    && u.len() > p.len()
            });
        if !local {
            return Err(AppError::invalid(
                "Ollama must run on this PC (http://127.0.0.1:<port>)",
            ));
        }
        if self.model.trim().is_empty() || self.model.len() > 100 {
            return Err(AppError::invalid("pick a model, e.g. qwen2.5:1.5b"));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub enabled: bool,
    pub reachable: bool,
    pub version: Option<String>,
    pub models: Vec<String>,
    pub model_installed: bool,
}

/// Direct connection to Ollama on this PC: never through a proxy from HTTP(S)_PROXY/ALL_PROXY
/// (that would send task text off the machine), never follow redirects, and let us read error
/// bodies ourselves.
fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}

fn base(cfg: &AiSettings) -> String {
    cfg.url.trim().trim_end_matches('/').to_string()
}

pub fn status(cfg: &AiSettings) -> AiStatus {
    // Off, or an address that is not this PC (e.g. from an old backup): do not contact anything.
    if !cfg.enabled || cfg.validate().is_err() {
        return AiStatus {
            enabled: cfg.enabled,
            reachable: false,
            version: None,
            models: vec![],
            model_installed: false,
        };
    }
    let a = agent(Duration::from_secs(3));
    let version = a
        .get(format!("{}/api/version", base(cfg)))
        .call()
        .ok()
        .and_then(|mut r| r.body_mut().read_json::<Value>().ok())
        .and_then(|v| v["version"].as_str().map(str::to_string));
    let models: Vec<String> = a
        .get(format!("{}/api/tags", base(cfg)))
        .call()
        .ok()
        .and_then(|mut r| r.body_mut().read_json::<Value>().ok())
        .and_then(|v| {
            v["models"].as_array().map(|m| {
                m.iter()
                    .filter_map(|x| x["name"].as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default();
    let want = cfg.model.trim();
    AiStatus {
        enabled: cfg.enabled,
        reachable: version.is_some(),
        model_installed: models
            .iter()
            // Ollama reads a bare name as ":latest".
            .any(|m| m == want || (!want.contains(':') && *m == format!("{want}:latest"))),
        version,
        models,
    }
}

/// A tiny prompt to prove the model answers. Allows time for the model to load the first time.
pub fn test(cfg: &AiSettings) -> AppResult<(bool, f64)> {
    #[derive(Deserialize)]
    struct Reply {
        ok: bool,
    }
    let schema = json!({
        "type": "object",
        "properties": { "ok": { "type": "boolean" } },
        "required": ["ok"]
    });
    let (r, tps): (Reply, f64) = chat_with(
        cfg,
        "You are a connection test.",
        "Reply with ok set to true.",
        schema,
        Duration::from_secs(90),
    )?;
    Ok((r.ok, tps))
}

/// One structured chat call: the reply must match `schema`. Returns the value and tokens/second.
fn chat<T: DeserializeOwned>(
    cfg: &AiSettings,
    system: &str,
    user: &str,
    schema: Value,
) -> AppResult<(T, f64)> {
    chat_with(cfg, system, user, schema, Duration::from_secs(120))
}

fn chat_with<T: DeserializeOwned>(
    cfg: &AiSettings,
    system: &str,
    user: &str,
    schema: Value,
    timeout: Duration,
) -> AppResult<(T, f64)> {
    if !cfg.enabled {
        return Err(AppError::invalid(
            "Local AI is off. Turn it on in Settings.",
        ));
    }
    cfg.validate()?;
    let body = json!({
        "model": cfg.model.trim(),
        "stream": false,
        "format": schema,
        "keep_alive": "2m",          // free the RAM soon after use
        "think": false,              // reasoning models (qwen3) answer directly; others ignore it
        "options": { "temperature": 0, "num_ctx": 4096 },
        "messages": [
            { "role": "system", "content": format!("{system}\nReply with JSON only, matching this schema: {schema}") },
            { "role": "user", "content": user }
        ]
    });
    let started = Instant::now();
    let mut res = agent(timeout)
        .post(format!("{}/api/chat", base(cfg)))
        .send_json(&body)
        .map_err(|e| {
            log::warn!("ollama request failed: {e}");
            AppError::invalid("Ollama is not running on this PC. Start Ollama and try again.")
        })?;
    let code = res.status().as_u16();
    if code != 200 {
        let msg = res
            .body_mut()
            .read_json::<Value>()
            .ok()
            .and_then(|v| v["error"].as_str().map(str::to_string))
            .unwrap_or_default();
        return Err(if code == 404 && msg.contains("not found") {
            AppError::invalid(format!(
                "The model {} is not installed. Run: ollama pull {}",
                cfg.model, cfg.model
            ))
        } else {
            AppError::invalid(format!(
                "Ollama returned {code}{}",
                if msg.is_empty() {
                    String::new()
                } else {
                    format!(": {msg}")
                }
            ))
        });
    }
    let reply: Value = res
        .body_mut()
        .read_json()
        .map_err(|_| AppError::invalid("Ollama sent an unreadable reply"))?;
    let content = reply["message"]["content"].as_str().unwrap_or_default();
    let parsed: T = serde_json::from_str(content).map_err(|_| {
        AppError::invalid("The model's answer was not in the expected shape; try again")
    })?;
    let tokens = reply["eval_count"].as_f64().unwrap_or(0.0);
    let secs = reply["eval_duration"]
        .as_f64()
        .map(|ns| ns / 1e9)
        .unwrap_or_else(|| started.elapsed().as_secs_f64());
    Ok((parsed, if secs > 0.0 { tokens / secs } else { 0.0 }))
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default, deserialize_with = "lenient_priority")]
    pub priority: Option<u8>,
    #[serde(default)]
    pub project_name: Option<String>,
}

/// Accept 2, 2.0 or out-of-range numbers without failing the whole reply; keep only 0-3.
fn lenient_priority<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u8>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.and_then(|v| v.as_f64())
        .filter(|f| (0.0..=3.0).contains(f) && f.fract() == 0.0)
        .map(|f| f as u8))
}

/// Turn captured text into a task suggestion. `today` anchors relative dates; `projects` are the
/// only allowed project names.
pub fn extract_task(
    cfg: &AiSettings,
    text: &str,
    page_title: Option<&str>,
    today: &str,
    projects: &[String],
) -> AppResult<(Extracted, f64)> {
    let schema = json!({
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "short imperative action, max 80 chars" },
            "description": { "type": ["string", "null"] },
            "dueDate": { "type": ["string", "null"], "description": "YYYY-MM-DD or null" },
            "priority": { "type": ["integer", "null"], "minimum": 0, "maximum": 3 },
            "projectName": { "type": ["string", "null"], "enum": projects.iter().map(|p| Value::from(p.as_str())).chain([Value::Null]).collect::<Vec<_>>() }
        },
        "required": ["title"]
    });
    let system = format!(
        "You turn a note someone highlighted into one to-do item for them. Today is {today}. \
         Resolve relative dates (\"Friday\", \"tomorrow\") to YYYY-MM-DD; if no date is stated use null. \
         Priority 3 only if the text says urgent/ASAP. Pick projectName only from the allowed list, else null. \
         Never invent facts that are not in the text."
    );
    let user = format!(
        "Page: {}\nText:\n{}",
        page_title.unwrap_or("(none)"),
        text.chars().take(3000).collect::<String>()
    );
    let (mut e, tps): (Extracted, f64) = chat(cfg, &system, &user, schema)?;
    // Never trust model output: clamp to the same rules as user input.
    e.title = clean_title(&e.title.chars().take(200).collect::<String>())?;
    e.due_date = clean_date("due date", &e.due_date).unwrap_or(None);
    e.priority = e.priority.filter(|p| *p <= 3);
    e.project_name = e.project_name.filter(|p| projects.contains(p));
    e.description = e.description.map(|d| d.chars().take(2000).collect());
    Ok((e, tps))
}

/// Split a task into 2-8 concrete steps.
pub fn break_down(cfg: &AiSettings, title: &str, details: &str) -> AppResult<(Vec<String>, f64)> {
    #[derive(Deserialize)]
    struct Steps {
        steps: Vec<String>,
    }
    let schema = json!({
        "type": "object",
        "properties": { "steps": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 8 } },
        "required": ["steps"]
    });
    let system = "Break the task into 2 to 8 small, concrete next steps, each a short imperative sentence. \
                  Use only what the task says; do not add unrelated work.";
    let user = format!(
        "Task: {title}\nDetails:\n{}",
        details.chars().take(3000).collect::<String>()
    );
    let (s, tps): (Steps, f64) = chat(cfg, system, &user, schema)?;
    let steps: Vec<String> = s
        .steps
        .into_iter()
        .filter_map(|x| clean_title(&x.chars().take(200).collect::<String>()).ok())
        .take(8)
        .collect();
    if steps.is_empty() {
        return Err(AppError::invalid(
            "The model did not suggest any steps; try again",
        ));
    }
    Ok((steps, tps))
}

/// About 2,000 tokens of transcript per call, so the prompt and the answer fit in 4,096.
const MEETING_CHUNK_CHARS: usize = 7000;

fn chunks(lines: &[String], max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in lines {
        let line: String = line.chars().take(max).collect();
        if !cur.is_empty() && cur.len() + line.len() + 1 > max {
            out.push(std::mem::take(&mut cur));
        }
        cur.push_str(&line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// Summarise a meeting transcript ("[10:02] Name: text" lines) in parts, then join the parts.
/// "You" is the user. Owners are kept so only the user's items become suggestions.
pub fn summarise_meeting(
    cfg: &AiSettings,
    lines: &[String],
    meeting_date: &str,
) -> AppResult<crate::repo::meetings::MeetingSummary> {
    use crate::repo::meetings::{ActionItem, MeetingSummary};
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Part {
        summary: String,
        decisions: Vec<String>,
        action_items: Vec<ActionItem>,
    }
    let schema = json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string", "description": "2-4 sentences" },
            "decisions": { "type": "array", "items": { "type": "string" } },
            "actionItems": { "type": "array", "items": { "type": "object", "properties": {
                "owner": { "type": "string", "description": "speaker name exactly as in the transcript; You for the user" },
                "title": { "type": "string", "description": "short imperative action" },
                "dueDate": { "type": ["string", "null"], "description": "YYYY-MM-DD or null" },
                "quote": { "type": ["string", "null"], "description": "the words that show it" }
            }, "required": ["owner", "title"] } }
        },
        "required": ["summary", "decisions", "actionItems"]
    });
    let system = format!(
        "You take notes for a meeting held on {meeting_date}. The transcript is from live captions and \
         may have errors. The speaker \"You\" is the person you work for. Write a short summary, the \
         decisions made, and the action items. For each action item set owner to the person who will do \
         it, using the speaker name as written; use \"You\" when the person you work for agreed to do \
         it or was asked to do it. Resolve relative dates against the meeting date; if none, null. \
         Only use what the transcript says."
    );
    let timeout = Duration::from_secs(600);
    let parts_text = chunks(lines, MEETING_CHUNK_CHARS);
    if parts_text.is_empty() {
        return Err(AppError::invalid("the meeting has no captions"));
    }
    let n = parts_text.len();
    let mut parts = Vec::with_capacity(n);
    for (i, text) in parts_text.iter().enumerate() {
        let user = if n == 1 {
            format!("Transcript:\n{text}")
        } else {
            format!("Part {} of {n} of the transcript:\n{text}", i + 1)
        };
        let (p, _): (Part, f64) = chat_with(cfg, &system, &user, schema.clone(), timeout)?;
        parts.push(p);
    }
    let mut out = MeetingSummary::default();
    for p in &parts {
        out.decisions.extend(p.decisions.iter().cloned());
        out.action_items.extend(p.action_items.iter().cloned());
    }
    out.summary = if n == 1 {
        parts[0].summary.clone()
    } else {
        #[derive(Deserialize)]
        struct Joined {
            summary: String,
        }
        let notes = parts
            .iter()
            .enumerate()
            .map(|(i, p)| format!("Part {}: {}", i + 1, p.summary.trim()))
            .collect::<Vec<_>>()
            .join("\n");
        let (j, _): (Joined, f64) = chat_with(
            cfg,
            "Join these notes on parts of one meeting into one summary of 3 to 6 sentences. \
             Only use what the notes say.",
            &notes,
            json!({ "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] }),
            timeout,
        )?;
        j.summary
    };
    if out.summary.trim().is_empty() {
        return Err(AppError::invalid(
            "The model did not write a summary; try again",
        ));
    }
    Ok(crate::repo::meetings::clean_summary(&out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        routing::{get, post},
    };

    /// A fake Ollama on a random port that answers /api/chat with `content`.
    fn fake_ollama(content: &'static str) -> String {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let listener = rt
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            rt.block_on(async move {
                let app = Router::new()
                    .route("/api/version", get(|| async { Json(json!({ "version": "0.12.0" })) }))
                    .route("/api/tags", get(|| async { Json(json!({ "models": [{ "name": "qwen2.5:1.5b" }] })) }))
                    .route(
                        "/api/chat",
                        post(move |_body: String| async move {
                            Json(json!({ "message": { "content": content }, "eval_count": 40, "eval_duration": 4_000_000_000u64 }))
                        }),
                    );
                axum::serve(listener, app).await.unwrap();
            });
        });
        format!("http://127.0.0.1:{port}")
    }

    fn on(url: String) -> AiSettings {
        AiSettings {
            enabled: true,
            url,
            ..Default::default()
        }
    }

    #[test]
    fn settings_accept_only_this_pc() {
        assert!(AiSettings::default().validate().is_ok());
        assert!(
            AiSettings {
                url: "http://localhost:11434/".into(),
                ..Default::default()
            }
            .validate()
            .is_ok()
        );
        assert!(
            AiSettings {
                url: "https://api.example.com".into(),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            AiSettings {
                url: "http://127.0.0.1.evil.com:80".into(),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            AiSettings {
                url: "http://10.0.0.5:11434".into(),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn off_means_no_call() {
        let e = extract_task(&AiSettings::default(), "x", None, "2026-11-23", &[]);
        assert!(matches!(e, Err(AppError::Invalid(m)) if m.contains("off")));
    }

    #[test]
    fn extract_is_cleaned_and_limited_to_known_projects() {
        let url = fake_ollama(
            r#"{"title":"  Follow up with Niamh ","description":"SEPI teacher list","dueDate":"2026-11-27","priority":7.0,"projectName":"Invented"}"#,
        );
        let (e, tps) = extract_task(
            &on(url),
            "Follow up with Niamh about the SEPI list before Friday",
            Some("Inbox"),
            "2026-11-23",
            &["Admin".into()],
        )
        .unwrap();
        assert_eq!(e.title, "Follow up with Niamh");
        assert_eq!(e.due_date.as_deref(), Some("2026-11-27"));
        assert_eq!(e.priority, None, "out-of-range priority dropped");
        assert_eq!(e.project_name, None, "unknown project dropped");
        assert!((tps - 10.0).abs() < 0.01);
    }

    #[test]
    fn bad_model_output_is_an_error_not_a_crash() {
        let url = fake_ollama("this is not json");
        assert!(extract_task(&on(url), "x y z", None, "2026-11-23", &[]).is_err());
    }

    #[test]
    fn breakdown_and_summary() {
        let url = fake_ollama(r#"{"steps":["Fix validation","  ","Test Irish translations"]}"#);
        let (steps, _) = break_down(&on(url), "Finish profile", "").unwrap();
        assert_eq!(steps, ["Fix validation", "Test Irish translations"]);
    }

    #[test]
    fn meeting_summary_keeps_owners_and_cleans_output() {
        let url = fake_ollama(
            r#"{"summary":"Report goes out Friday.","decisions":["Ship Friday"],"actionItems":[{"owner":"You","title":"Send the report","dueDate":"2026-11-27","quote":"I'll send it"},{"owner":"Sarah","title":"Book the room","dueDate":"not a date"}]}"#,
        );
        let lines = vec![
            "[10:01] Sarah: Can you send the report by Friday?".to_string(),
            "[10:01] You: Yes.".to_string(),
        ];
        let s = summarise_meeting(&on(url), &lines, "2026-11-23").unwrap();
        assert_eq!(s.summary, "Report goes out Friday.");
        assert_eq!(s.action_items.len(), 2);
        assert_eq!(s.action_items[0].owner.as_deref(), Some("You"));
        assert_eq!(s.action_items[1].due_date, None);
    }

    #[test]
    fn transcript_is_split_into_parts() {
        let lines: Vec<String> = (0..50)
            .map(|i| format!("[10:{i:02}] You: {}", "word ".repeat(40)))
            .collect();
        let parts = chunks(&lines, 2000);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|p| p.len() <= 2000));
        assert_eq!(parts.concat().lines().count(), 50);
    }

    #[test]
    fn off_means_no_probe() {
        let s = status(&AiSettings {
            enabled: false,
            ..Default::default()
        });
        assert!(!s.reachable && s.version.is_none());
        let bad = status(&AiSettings {
            enabled: true,
            url: "http://10.0.0.5:11434".into(),
            ..Default::default()
        });
        assert!(!bad.reachable);
    }

    #[test]
    fn model_names_match_like_ollama() {
        let url = fake_ollama("{}");
        assert!(
            !status(&AiSettings {
                model: "qwen2.5".into(),
                ..on(url.clone())
            })
            .model_installed
        );
        assert!(
            status(&AiSettings {
                model: "qwen2.5:1.5b".into(),
                ..on(url)
            })
            .model_installed
        );
    }

    #[test]
    fn status_reports_model() {
        let url = fake_ollama("{}");
        let s = status(&on(url));
        assert!(s.reachable && s.model_installed);
        assert_eq!(s.version.as_deref(), Some("0.12.0"));
        let down = status(&on("http://127.0.0.1:9".into()));
        assert!(!down.reachable);
    }
}
