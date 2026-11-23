//! Reminder planning: which notifications are due in a time window. Pure over the database and a
//! clock, so it is tested without Windows. `scheduler.rs` runs it every 30 s and shows the toasts.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppResult,
    model::{Task, new_id, now_utc},
    repo::{settings, suggestions, tasks},
};

pub const SETTINGS_KEY: &str = "reminders";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReminderSettings {
    pub enabled: bool,
    /// Minutes before a timed task's due time; 0 = no early warning.
    pub due_soon_minutes: i64,
    /// Remind again this long after a timed task fell due, if still open; 0 = never.
    pub overdue_after_minutes: i64,
    pub briefing_enabled: bool,
    pub briefing_time: String,
    pub review_enabled: bool,
    pub review_time: String,
    /// Gentle nudge about the most important open task; 0 = off.
    pub nudge_minutes: i64,
    pub work_start: String,
    pub work_end: String,
    /// ISO weekdays (1 = Monday ... 7 = Sunday).
    pub work_days: Vec<u32>,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            due_soon_minutes: 15,
            overdue_after_minutes: 60,
            briefing_enabled: true,
            briefing_time: "09:00".into(),
            review_enabled: true,
            review_time: "17:30".into(),
            nudge_minutes: 0,
            work_start: "09:00".into(),
            work_end: "18:00".into(),
            work_days: vec![1, 2, 3, 4, 5],
        }
    }
}

impl ReminderSettings {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        Ok(settings::get(conn, SETTINGS_KEY)?
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default())
    }

    pub fn validate(&self) -> AppResult<()> {
        for t in [
            &self.briefing_time,
            &self.review_time,
            &self.work_start,
            &self.work_end,
        ] {
            NaiveTime::parse_from_str(t, "%H:%M")
                .map_err(|_| crate::error::AppError::invalid("times must be HH:MM"))?;
        }
        if !(0..=24 * 60).contains(&self.due_soon_minutes)
            || !(0..=24 * 60).contains(&self.overdue_after_minutes)
            || !(0..=24 * 60).contains(&self.nudge_minutes)
            || (self.nudge_minutes > 0 && self.nudge_minutes < 15)
        {
            return Err(crate::error::AppError::invalid(
                "minutes out of range (nudges at least every 15 minutes)",
            ));
        }
        if self.work_days.iter().any(|d| !(1..=7).contains(d)) {
            return Err(crate::error::AppError::invalid("work days are 1-7"));
        }
        Ok(())
    }

    fn time(s: &str, fallback: (u32, u32)) -> NaiveTime {
        NaiveTime::parse_from_str(s, "%H:%M")
            .unwrap_or_else(|_| NaiveTime::from_hms_opt(fallback.0, fallback.1, 0).expect("valid"))
    }

    fn is_work_day(&self, d: NaiveDate) -> bool {
        self.work_days.contains(&d.weekday().number_from_monday())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Notice {
    DueSoon {
        task: Task,
    },
    Due {
        task: Task,
    },
    Overdue {
        task: Task,
    },
    Snooze {
        task: Task,
    },
    Briefing {
        due_today: usize,
        overdue: usize,
        /// Planned for an earlier day and still open ("outstanding from yesterday").
        carried_over: usize,
        /// Due in the next 3 days.
        upcoming: usize,
        suggestions: usize,
    },
    Review {
        open: usize,
    },
    Nudge {
        task: Task,
    },
}

impl Notice {
    /// (reminder kind, task id) used to record that it fired.
    fn key(&self) -> (&'static str, Option<&str>) {
        match self {
            Notice::DueSoon { task } => ("due_soon", Some(&task.id)),
            Notice::Due { task } => ("due", Some(&task.id)),
            Notice::Overdue { task } => ("overdue", Some(&task.id)),
            Notice::Snooze { task } => ("snooze", Some(&task.id)),
            Notice::Briefing { .. } => ("briefing", None),
            Notice::Review { .. } => ("eod_review", None),
            Notice::Nudge { task } => ("nudge", Some(&task.id)),
        }
    }
}

fn local_dt(date: NaiveDate, time: NaiveTime) -> DateTime<Local> {
    let naive = NaiveDateTime::new(date, time);
    Local
        .from_local_datetime(&naive)
        .earliest()
        .unwrap_or_else(|| Local.from_utc_datetime(&naive))
}

fn utc_str(t: DateTime<Local>) -> String {
    t.with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn already_fired(
    conn: &Connection,
    kind: &str,
    task: Option<&str>,
    fire_at: &str,
) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM reminders WHERE kind = ?1 AND task_id IS ?2 AND fire_at = ?3 AND fired_at IS NOT NULL",
            params![kind, task, fire_at],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn record_fired(conn: &Connection, kind: &str, task: Option<&str>, fire_at: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO reminders(id, task_id, kind, fire_at, fired_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![new_id(), task, kind, fire_at, now_utc()],
    )?;
    Ok(())
}

/// Open, live, top-level tasks.
fn open_tasks(conn: &Connection) -> AppResult<Vec<Task>> {
    let sql = format!(
        "SELECT {} FROM tasks t WHERE t.deleted_at IS NULL AND t.parent_id IS NULL
           AND t.status NOT IN ('completed','archived') {} LIMIT 2000",
        tasks::COLS,
        tasks::ORDER
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], tasks::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every notice whose moment falls in `(from, to]`, recorded as fired so it never repeats.
/// Snoozed tasks are only reminded by their snooze.
pub fn due_notices(
    conn: &Connection,
    cfg: &ReminderSettings,
    from: DateTime<Local>,
    to: DateTime<Local>,
) -> AppResult<Vec<Notice>> {
    if !cfg.enabled || to <= from {
        return Ok(vec![]);
    }
    let in_window = |t: DateTime<Local>| t > from && t <= to;
    let mut out: Vec<(String, Notice)> = Vec::new();
    let open = open_tasks(conn)?;

    // Snoozes (stored with fire_at in UTC).
    let snoozed: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT task_id, fire_at FROM reminders WHERE kind = 'snooze' AND fired_at IS NULL
               AND dismissed_at IS NULL AND task_id IS NOT NULL",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?
    };
    for (task_id, fire_at) in &snoozed {
        let Ok(at) = DateTime::parse_from_rfc3339(fire_at) else {
            continue;
        };
        if at.with_timezone(&Local) <= to {
            conn.execute(
                "UPDATE reminders SET fired_at = ?3 WHERE kind = 'snooze' AND task_id = ?1 AND fire_at = ?2",
                params![task_id, fire_at, now_utc()],
            )?;
            if let Some(t) = open.iter().find(|t| &t.id == task_id) {
                out.push((fire_at.clone(), Notice::Snooze { task: t.clone() }));
            }
        }
    }
    let is_snoozed = |id: &str| snoozed.iter().any(|(t, _)| t == id);

    for t in &open {
        let (Some(d), Some(tm)) = (&t.due_date, &t.due_time) else {
            continue;
        };
        if is_snoozed(&t.id) {
            continue;
        }
        let (Ok(d), Ok(tm)) = (
            NaiveDate::parse_from_str(d, "%Y-%m-%d"),
            NaiveTime::parse_from_str(tm, "%H:%M"),
        ) else {
            continue;
        };
        let due = local_dt(d, tm);
        let mut moments = vec![(due, Notice::Due { task: t.clone() })];
        if cfg.due_soon_minutes > 0 {
            moments.push((
                due - Duration::minutes(cfg.due_soon_minutes),
                Notice::DueSoon { task: t.clone() },
            ));
        }
        if cfg.overdue_after_minutes > 0 {
            moments.push((
                due + Duration::minutes(cfg.overdue_after_minutes),
                Notice::Overdue { task: t.clone() },
            ));
        }
        for (at, n) in moments {
            if in_window(at) {
                out.push((utc_str(at), n));
            }
        }
    }

    // Daily moments, for each day the window touches (normally one).
    let mut day = from.date_naive();
    while day <= to.date_naive() {
        if cfg.is_work_day(day) {
            let today = day.format("%Y-%m-%d").to_string();
            if cfg.briefing_enabled {
                let at = local_dt(day, ReminderSettings::time(&cfg.briefing_time, (9, 0)));
                if in_window(at) {
                    let active: Vec<&Task> = open
                        .iter()
                        .filter(|t| t.status != crate::model::TaskStatus::Inbox)
                        .collect();
                    let soon_end = (day + Duration::days(3)).format("%Y-%m-%d").to_string();
                    let overdue = active
                        .iter()
                        .filter(|t| t.due_date.as_deref().is_some_and(|d| d < today.as_str()))
                        .count();
                    let due_today = active
                        .iter()
                        .filter(|t| {
                            t.due_date.as_deref() == Some(today.as_str())
                                || (t.scheduled_date.as_deref() == Some(today.as_str())
                                    && t.due_date.as_deref().is_none_or(|d| d >= today.as_str()))
                        })
                        .count();
                    let carried_over = active
                        .iter()
                        .filter(|t| {
                            t.scheduled_date
                                .as_deref()
                                .is_some_and(|d| d < today.as_str())
                                && t.due_date.as_deref().is_none_or(|d| d > today.as_str())
                        })
                        .count();
                    let upcoming = active
                        .iter()
                        .filter(|t| {
                            t.due_date
                                .as_deref()
                                .is_some_and(|d| d > today.as_str() && d <= soon_end.as_str())
                        })
                        .count();
                    let suggestions = suggestions::pending_counts(conn)?
                        .iter()
                        .map(|(_, n)| *n as usize)
                        .sum();
                    out.push((
                        utc_str(at),
                        Notice::Briefing {
                            due_today,
                            overdue,
                            carried_over,
                            upcoming,
                            suggestions,
                        },
                    ));
                }
            }
            if cfg.review_enabled {
                let at = local_dt(day, ReminderSettings::time(&cfg.review_time, (17, 30)));
                if in_window(at) {
                    let open_today = open
                        .iter()
                        .filter(|t| {
                            t.due_date.as_deref().is_some_and(|d| d <= today.as_str())
                                || t.scheduled_date
                                    .as_deref()
                                    .is_some_and(|d| d <= today.as_str())
                        })
                        .count();
                    if open_today > 0 {
                        out.push((utc_str(at), Notice::Review { open: open_today }));
                    }
                }
            }
        }
        day = day.succ_opt().expect("date in range");
    }

    // Nudge: at most one per interval, inside working hours, never the same task within 3 h.
    if cfg.nudge_minutes > 0 && cfg.is_work_day(to.date_naive()) {
        let start = ReminderSettings::time(&cfg.work_start, (9, 0));
        let end = ReminderSettings::time(&cfg.work_end, (18, 0));
        let now_t = to.time();
        let last: Option<String> = conn
            .query_row(
                "SELECT max(fire_at) FROM reminders WHERE kind = 'nudge' AND fired_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let due_for_nudge = last
            .and_then(|l| DateTime::parse_from_rfc3339(&l).ok())
            .is_none_or(|l| to.signed_duration_since(l) >= Duration::minutes(cfg.nudge_minutes));
        if now_t >= start && now_t < end && due_for_nudge {
            let recent_cut = utc_str(to - Duration::hours(3));
            let today = to.date_naive().format("%Y-%m-%d").to_string();
            let mut candidates: Vec<&Task> = open
                .iter()
                .filter(|t| t.status != crate::model::TaskStatus::Inbox && !is_snoozed(&t.id))
                .filter(|t| {
                    t.due_date.as_deref().is_some_and(|d| d <= today.as_str())
                        || t.scheduled_date
                            .as_deref()
                            .is_some_and(|d| d <= today.as_str())
                })
                .collect();
            // Overdue first, then priority, then oldest.
            candidates.sort_by_key(|t| {
                (
                    t.due_date.clone().unwrap_or_else(|| "9999".into()),
                    std::cmp::Reverse(t.priority),
                )
            });
            for t in candidates {
                let recent: bool = conn
                    .query_row(
                        "SELECT 1 FROM reminders WHERE kind = 'nudge' AND task_id = ?1 AND fire_at >= ?2",
                        params![t.id, recent_cut],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if !recent {
                    out.push((utc_str(to), Notice::Nudge { task: t.clone() }));
                    break;
                }
            }
        }
    }

    // Record and de-duplicate (a restart or overlapping window must not repeat a notice).
    let mut fresh = Vec::new();
    for (fire_at, n) in out {
        let (kind, task) = n.key();
        if kind == "snooze" {
            fresh.push(n);
            continue;
        }
        if !already_fired(conn, kind, task, &fire_at)? {
            record_fired(conn, kind, task, &fire_at)?;
            fresh.push(n);
        }
    }
    Ok(fresh)
}

/// Snooze a task's reminders until `until`.
pub fn snooze(conn: &Connection, task_id: &str, until: DateTime<Local>) -> AppResult<()> {
    tasks::get(conn, task_id)?;
    conn.execute(
        "UPDATE reminders SET dismissed_at = ?2 WHERE kind = 'snooze' AND task_id = ?1 AND fired_at IS NULL",
        params![task_id, now_utc()],
    )?;
    conn.execute(
        "INSERT INTO reminders(id, task_id, kind, fire_at, created_at) VALUES (?1, ?2, 'snooze', ?3, ?4)",
        params![new_id(), task_id, utc_str(until), now_utc()],
    )?;
    Ok(())
}

/// What a toast button asked for. Strings look like `snooze:15:<id>`, `done:<id>`, `open:<id>`.
#[derive(Debug, PartialEq)]
pub enum Action {
    Snooze {
        task: String,
        minutes: i64,
    },
    /// Quiet until the start of the next work day (the task's dates are not changed).
    SnoozeTomorrow {
        task: String,
    },
    Tomorrow {
        task: String,
    },
    Done {
        task: String,
    },
    Open {
        path: String,
    },
}

pub fn parse_action(s: Option<&str>) -> Action {
    let s = s.unwrap_or("");
    let mut parts = s.splitn(3, ':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("snooze"), Some("tomorrow"), Some(id)) => Action::SnoozeTomorrow { task: id.into() },
        (Some("snooze"), Some(m), Some(id)) => match m.parse::<i64>() {
            Ok(minutes) if (1..=7 * 24 * 60).contains(&minutes) => Action::Snooze {
                task: id.into(),
                minutes,
            },
            _ => Action::Open { path: "/".into() },
        },
        (Some("tomorrow"), Some(id), None) => Action::Tomorrow { task: id.into() },
        (Some("done"), Some(id), None) => Action::Done { task: id.into() },
        (Some("open"), Some("review"), None) => Action::Open {
            path: "/review".into(),
        },
        (Some("open"), Some("inbox"), None) => Action::Open {
            path: "/inbox".into(),
        },
        (Some("open"), Some("today"), None) => Action::Open { path: "/".into() },
        (Some("open"), Some(id), None) => Action::Open {
            path: format!("/tasks?task={id}"),
        },
        _ => Action::Open { path: "/".into() },
    }
}

/// Next work day's start (e.g. tomorrow 09:00, or Monday after a Friday).
pub fn next_work_start(cfg: &ReminderSettings, now: DateTime<Local>) -> DateTime<Local> {
    let start = ReminderSettings::time(&cfg.work_start, (9, 0));
    let mut day = now.date_naive() + Duration::days(1);
    for _ in 0..7 {
        if cfg.is_work_day(day) {
            break;
        }
        day += Duration::days(1);
    }
    local_dt(day, start)
}

/// Move a task to tomorrow: the due date (keeping the time) or the do-on date. A do-on date of
/// today or earlier is cleared so the task leaves today's lists.
pub fn move_to_tomorrow(conn: &Connection, task_id: &str, today: NaiveDate) -> AppResult<Task> {
    let t = tasks::get(conn, task_id)?;
    let tomorrow = (today + Duration::days(1)).format("%Y-%m-%d").to_string();
    let today_s = today.format("%Y-%m-%d").to_string();
    if t.due_date.is_some() {
        tasks::reschedule(
            conn,
            task_id,
            Some(tomorrow),
            t.due_time.clone(),
            crate::model::Actor::User,
        )?;
        if t.scheduled_date
            .as_deref()
            .is_some_and(|d| d <= today_s.as_str())
        {
            return tasks::schedule(conn, task_id, None, crate::model::Actor::User);
        }
        tasks::get(conn, task_id)
    } else {
        tasks::schedule(conn, task_id, Some(tomorrow), crate::model::Actor::User)
    }
}

/// Drop reminder rows that fired or were dismissed more than `days` ago.
pub fn prune(conn: &Connection, days: i64) -> AppResult<usize> {
    let cut = (chrono::Utc::now() - Duration::days(days))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    Ok(conn.execute(
        "DELETE FROM reminders WHERE coalesce(fired_at, dismissed_at) IS NOT NULL AND coalesce(fired_at, dismissed_at) < ?1",
        [cut],
    )?)
}

/// Collapse notices found after a gap (sleep, app closed): per task only the latest stage counts.
pub fn collapse_missed(notices: Vec<Notice>) -> Vec<Notice> {
    fn rank(n: &Notice) -> u8 {
        match n {
            Notice::DueSoon { .. } => 1,
            Notice::Due { .. } => 2,
            Notice::Snooze { .. } | Notice::Nudge { .. } => 3,
            Notice::Overdue { .. } => 4,
            _ => 0,
        }
    }
    let mut out: Vec<Notice> = Vec::new();
    for n in notices {
        let id = n.key().1.map(str::to_string);
        match id {
            Some(id) => {
                if let Some(pos) = out.iter().position(|o| o.key().1 == Some(id.as_str())) {
                    if rank(&n) > rank(&out[pos]) {
                        out[pos] = n;
                    }
                } else {
                    out.push(n);
                }
            }
            None => out.push(n),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{Actor, TaskInput, TaskOrigin, TaskStatus},
        repo::test_util::db,
    };

    fn at(d: &str, t: &str) -> DateTime<Local> {
        local_dt(
            NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap(),
            NaiveTime::parse_from_str(t, "%H:%M").unwrap(),
        )
    }

    fn mk(db: &crate::db::Db, title: &str, date: Option<&str>, time: Option<&str>) -> Task {
        db.write(|c| {
            tasks::create(
                c,
                &TaskInput {
                    title: title.into(),
                    due_date: date.map(Into::into),
                    due_time: time.map(Into::into),
                    ..Default::default()
                },
                &TaskOrigin::default(),
                Actor::User,
            )
        })
        .unwrap()
    }

    fn kinds(v: &[Notice]) -> Vec<&'static str> {
        v.iter().map(|n| n.key().0).collect()
    }

    // Monday 2026-11-23.
    #[test]
    fn timed_task_gets_soon_due_and_overdue_once() {
        let db = db();
        mk(&db, "Call venue", Some("2026-11-23"), Some("14:00"));
        let cfg = ReminderSettings {
            briefing_enabled: false,
            review_enabled: false,
            ..Default::default()
        };
        let run = |a: &str, b: &str| {
            db.write(|c| due_notices(c, &cfg, at("2026-11-23", a), at("2026-11-23", b)))
                .unwrap()
        };
        assert!(run("13:00", "13:44").is_empty());
        assert_eq!(kinds(&run("13:44", "13:45")), ["due_soon"]);
        assert_eq!(kinds(&run("13:59", "14:00")), ["due"]);
        assert!(run("13:59", "14:00").is_empty(), "never repeats");
        assert_eq!(kinds(&run("14:59", "15:00")), ["overdue"]);
    }

    #[test]
    fn completed_tasks_are_silent_and_disabled_means_nothing() {
        let db = db();
        let t = mk(&db, "Call venue", Some("2026-11-23"), Some("14:00"));
        db.write(|c| tasks::set_status(c, &t.id, TaskStatus::Completed, false, Actor::User))
            .unwrap();
        let cfg = ReminderSettings::default();
        assert!(
            db.write(|c| due_notices(
                c,
                &cfg,
                at("2026-11-23", "13:00"),
                at("2026-11-23", "15:30")
            ))
            .unwrap()
            .iter()
            .all(|n| !matches!(n, Notice::Due { .. }))
        );
        let off = ReminderSettings {
            enabled: false,
            ..Default::default()
        };
        mk(&db, "Other", Some("2026-11-23"), Some("14:00"));
        assert!(
            db.write(|c| due_notices(
                c,
                &off,
                at("2026-11-23", "13:00"),
                at("2026-11-23", "15:30")
            ))
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn briefing_on_work_days_with_counts_and_not_on_weekends() {
        let db = db();
        mk(&db, "Late", Some("2026-11-20"), None);
        mk(&db, "Today", Some("2026-11-23"), None);
        let cfg = ReminderSettings::default();
        let n = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", "08:59"),
                    at("2026-11-23", "09:00"),
                )
            })
            .unwrap();
        assert_eq!(
            n,
            vec![Notice::Briefing {
                due_today: 1,
                overdue: 1,
                carried_over: 0,
                upcoming: 0,
                suggestions: 0
            }]
        );
        // Saturday 2026-11-28.
        let sat = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-28", "08:59"),
                    at("2026-11-28", "09:01"),
                )
            })
            .unwrap();
        assert!(sat.is_empty());
    }

    #[test]
    fn review_only_when_something_is_open() {
        let db = db();
        let cfg = ReminderSettings::default();
        let none = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", "17:29"),
                    at("2026-11-23", "17:30"),
                )
            })
            .unwrap();
        assert!(none.is_empty());
        mk(&db, "Today", Some("2026-11-23"), None);
        let n = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-24", "17:29"),
                    at("2026-11-24", "17:30"),
                )
            })
            .unwrap();
        assert_eq!(n, vec![Notice::Review { open: 1 }]);
    }

    #[test]
    fn sleep_catch_up_returns_every_missed_notice_once() {
        let db = db();
        mk(&db, "A", Some("2026-11-23"), Some("10:00"));
        mk(&db, "B", Some("2026-11-23"), Some("11:00"));
        let cfg = ReminderSettings {
            due_soon_minutes: 0,
            overdue_after_minutes: 0,
            review_enabled: false,
            ..Default::default()
        };
        // Asleep 08:00 -> 12:00: briefing + two dues.
        let n = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", "08:00"),
                    at("2026-11-23", "12:00"),
                )
            })
            .unwrap();
        assert_eq!(n.len(), 3);
    }

    #[test]
    fn snooze_replaces_normal_reminders_and_fires_once() {
        let db = db();
        let t = mk(&db, "Call venue", Some("2026-11-23"), Some("14:00"));
        db.write(|c| snooze(c, &t.id, at("2026-11-23", "14:30")))
            .unwrap();
        let cfg = ReminderSettings {
            overdue_after_minutes: 0,
            ..Default::default()
        };
        let n = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", "13:50"),
                    at("2026-11-23", "14:10"),
                )
            })
            .unwrap();
        assert!(n.is_empty(), "snoozed task stays quiet: {n:?}");
        let n = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", "14:10"),
                    at("2026-11-23", "14:31"),
                )
            })
            .unwrap();
        assert_eq!(kinds(&n), ["snooze"]);
        let n = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", "14:31"),
                    at("2026-11-23", "14:40"),
                )
            })
            .unwrap();
        assert!(n.is_empty());
    }

    #[test]
    fn nudge_respects_hours_interval_and_task_cooldown() {
        let db = db();
        mk(&db, "Overdue", Some("2026-11-20"), None);
        mk(&db, "Today", Some("2026-11-23"), None);
        let cfg = ReminderSettings {
            nudge_minutes: 60,
            briefing_enabled: false,
            review_enabled: false,
            ..Default::default()
        };
        let tick = |t: &str| {
            db.write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", t) - Duration::seconds(30),
                    at("2026-11-23", t),
                )
            })
            .unwrap()
        };
        assert!(tick("08:30").is_empty(), "before work hours");
        let first = tick("10:00");
        assert!(matches!(&first[..], [Notice::Nudge { task }] if task.title == "Overdue"));
        assert!(tick("10:30").is_empty(), "interval not reached");
        let second = tick("11:00");
        assert!(
            matches!(&second[..], [Notice::Nudge { task }] if task.title == "Today"),
            "{second:?}"
        );
    }

    #[test]
    fn actions_parse_safely() {
        assert_eq!(
            parse_action(Some("snooze:15:T1")),
            Action::Snooze {
                task: "T1".into(),
                minutes: 15
            }
        );
        assert_eq!(
            parse_action(Some("snooze:abc:T1")),
            Action::Open { path: "/".into() }
        );
        assert_eq!(
            parse_action(Some("done:T1")),
            Action::Done { task: "T1".into() }
        );
        assert_eq!(
            parse_action(Some("tomorrow:T1")),
            Action::Tomorrow { task: "T1".into() }
        );
        assert_eq!(
            parse_action(Some("open:review")),
            Action::Open {
                path: "/review".into()
            }
        );
        assert_eq!(
            parse_action(Some("open:today")),
            Action::Open { path: "/".into() }
        );
        assert_eq!(
            parse_action(Some("snooze:tomorrow:T1")),
            Action::SnoozeTomorrow { task: "T1".into() }
        );
        assert_eq!(
            parse_action(Some("open:T9")),
            Action::Open {
                path: "/tasks?task=T9".into()
            }
        );
        assert_eq!(parse_action(None), Action::Open { path: "/".into() });
    }

    #[test]
    fn missed_notices_collapse_per_task() {
        let db = db();
        mk(&db, "A", Some("2026-11-23"), Some("14:00"));
        let cfg = ReminderSettings {
            briefing_enabled: false,
            review_enabled: false,
            ..Default::default()
        };
        // Asleep 13:30 -> 15:30 over A: due soon, due and overdue all fall in the gap.
        let n = db
            .write(|c| {
                due_notices(
                    c,
                    &cfg,
                    at("2026-11-23", "13:30"),
                    at("2026-11-23", "15:30"),
                )
            })
            .unwrap();
        assert_eq!(n.len(), 3);
        let c = collapse_missed(n);
        assert_eq!(kinds(&c), ["overdue"]);
    }

    #[test]
    fn next_work_start_skips_weekend() {
        let cfg = ReminderSettings::default();
        // Friday 2026-11-27 16:00 -> Monday 09:00.
        assert_eq!(
            next_work_start(&cfg, at("2026-11-27", "16:00")),
            at("2026-11-30", "09:00")
        );
        assert_eq!(
            next_work_start(&cfg, at("2026-11-23", "16:00")),
            at("2026-11-24", "09:00")
        );
    }

    #[test]
    fn moving_a_dated_task_clears_an_old_do_on_date() {
        let db = db();
        let t = db
            .write(|c| {
                tasks::create(
                    c,
                    &TaskInput {
                        title: "Planned".into(),
                        due_date: Some("2026-11-25".into()),
                        scheduled_date: Some("2026-11-23".into()),
                        ..Default::default()
                    },
                    &TaskOrigin::default(),
                    Actor::User,
                )
            })
            .unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 11, 23).unwrap();
        let m = db.write(|c| move_to_tomorrow(c, &t.id, today)).unwrap();
        assert_eq!(
            (m.due_date.as_deref(), m.scheduled_date.as_deref()),
            (Some("2026-11-24"), None)
        );
    }

    #[test]
    fn tomorrow_keeps_time_or_sets_do_on_date() {
        let db = db();
        let timed = mk(&db, "Timed", Some("2026-11-23"), Some("14:00"));
        let undated = mk(&db, "Undated", None, None);
        let today = NaiveDate::from_ymd_opt(2026, 11, 23).unwrap();
        let a = db.write(|c| move_to_tomorrow(c, &timed.id, today)).unwrap();
        assert_eq!(
            (a.due_date.as_deref(), a.due_time.as_deref()),
            (Some("2026-11-24"), Some("14:00"))
        );
        let b = db
            .write(|c| move_to_tomorrow(c, &undated.id, today))
            .unwrap();
        assert_eq!(b.scheduled_date.as_deref(), Some("2026-11-24"));
    }

    #[test]
    fn settings_validate() {
        assert!(ReminderSettings::default().validate().is_ok());
        assert!(
            ReminderSettings {
                briefing_time: "9am".into(),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            ReminderSettings {
                nudge_minutes: 5,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}
