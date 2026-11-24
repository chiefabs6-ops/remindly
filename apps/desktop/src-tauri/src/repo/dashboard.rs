//! The "Today" view. All buckets hold open, live, top-level tasks.

use chrono::{DateTime, Duration, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use rusqlite::{Connection, ToSql, params_from_iter};
use serde::Serialize;

use crate::{
    error::AppResult,
    model::{Origin, Suggestion, SuggestionStatus, Task},
    repo::{suggestions, tasks},
};

/// Local "now" broken into the parts the queries need. Injected so tests can fix the clock.
#[derive(Debug, Clone)]
pub struct Clock {
    pub today: NaiveDate,
    /// Local time "HH:MM".
    pub now_hm: String,
    /// UTC bounds of the local day, RFC 3339 (same format as stored timestamps).
    pub day_start_utc: String,
    pub day_end_utc: String,
    pub now_utc: String,
}

impl Clock {
    pub fn now() -> Self {
        Self::from_local(Local::now())
    }

    pub fn from_local<Tz: TimeZone>(now: DateTime<Tz>) -> Self
    where
        Tz::Offset: std::fmt::Display,
    {
        let tz = now.timezone();
        let today = now.date_naive();
        let to_utc = |d: NaiveDate| -> String {
            let local_midnight = d.and_hms_opt(0, 0, 0).expect("midnight");
            // `earliest` handles DST gaps/overlaps at midnight.
            tz.from_local_datetime(&local_midnight)
                .earliest()
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| Utc.from_utc_datetime(&local_midnight))
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        };
        Clock {
            today,
            now_hm: now.format("%H:%M").to_string(),
            day_start_utc: to_utc(today),
            day_end_utc: to_utc(today + Duration::days(1)),
            now_utc: now
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        }
    }

    fn date(&self, offset_days: i64) -> String {
        (self.today + Duration::days(offset_days))
            .format("%Y-%m-%d")
            .to_string()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: i64,
    pub total: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCount {
    pub origin: Origin,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub today: String,
    pub overdue: Vec<Task>,
    pub due_today: Vec<Task>,
    pub carried_over: Vec<Task>,
    pub due_soon: Vec<Task>,
    pub upcoming: Vec<Task>,
    pub recent: Vec<Task>,
    pub inbox_count: i64,
    pub completed_today: Vec<Task>,
    pub progress: Progress,
    pub pending: Vec<PendingCount>,
    pub suggestions: Vec<Suggestion>,
}

/// Days after today that count as "due soon"; "upcoming" runs to `UPCOMING_DAYS`.
pub const DUE_SOON_DAYS: i64 = 3;
pub const UPCOMING_DAYS: i64 = 14;

const OPEN: &str = "t.deleted_at IS NULL AND t.parent_id IS NULL
    AND t.status NOT IN ('completed','archived')";

/// `due_date < today`, or due today with a time that has passed.
/// Wrapped in `coalesce` so undated tasks give 0, not NULL (NOT NULL would drop them).
const IS_OVERDUE: &str = "coalesce(t.due_date < ?1 OR (t.due_date = ?1 AND t.due_time IS NOT NULL AND t.due_time < ?2), 0)";

fn query(
    conn: &Connection,
    where_sql: &str,
    args: &[&dyn ToSql],
    order: &str,
) -> AppResult<Vec<Task>> {
    let sql = format!(
        "SELECT {} FROM tasks t WHERE {OPEN} AND {where_sql} {order} LIMIT 200",
        tasks::COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), tasks::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn build(conn: &Connection, clock: &Clock) -> AppResult<Dashboard> {
    let today = clock.date(0);
    let soon_end = clock.date(DUE_SOON_DAYS);
    let upcoming_end = clock.date(UPCOMING_DAYS);
    let base: [&dyn ToSql; 2] = [&today, &clock.now_hm];

    let overdue = query(conn, IS_OVERDUE, &base, tasks::ORDER)?;
    let due_today = query(
        conn,
        &format!(
            "NOT {IS_OVERDUE} AND t.status != 'inbox'
             AND (t.due_date = ?1 OR (t.scheduled_date = ?1 AND (t.due_date IS NULL OR t.due_date >= ?1)))"
        ),
        &base,
        tasks::ORDER,
    )?;
    // Planned for an earlier day and still open, but not (yet) overdue.
    let carried_over = query(
        conn,
        &format!(
            "NOT {IS_OVERDUE} AND t.status != 'inbox' AND t.scheduled_date < ?1
             AND (t.due_date IS NULL OR t.due_date > ?1)"
        ),
        &base,
        "ORDER BY t.scheduled_date, t.priority DESC",
    )?;
    let due_soon = query(
        conn,
        "t.due_date > ?1 AND t.due_date <= ?3 AND NOT coalesce(t.scheduled_date <= ?1, 0)",
        &[&today, &clock.now_hm, &soon_end],
        tasks::ORDER,
    )?;
    let upcoming = query(
        conn,
        "t.due_date > ?3 AND t.due_date <= ?4 AND NOT coalesce(t.scheduled_date <= ?1, 0)",
        &[&today, &clock.now_hm, &soon_end, &upcoming_end],
        tasks::ORDER,
    )?;
    let since = (Utc::now() - Duration::hours(24)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let recent = {
        let sql = format!(
            "SELECT {} FROM tasks t WHERE t.deleted_at IS NULL AND t.parent_id IS NULL
               AND t.created_at >= ?1 ORDER BY t.created_at DESC LIMIT 10",
            tasks::COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.query_map([&since], tasks::from_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let completed_today = {
        let sql = format!(
            "SELECT {} FROM tasks t WHERE t.deleted_at IS NULL AND t.status = 'completed'
               AND t.completed_at >= ?1 AND t.completed_at < ?2
             ORDER BY t.completed_at DESC LIMIT 200",
            tasks::COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.query_map([&clock.day_start_utc, &clock.day_end_utc], tasks::from_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let inbox_count: i64 = conn.query_row(
        "SELECT count(*) FROM tasks t WHERE t.deleted_at IS NULL AND t.parent_id IS NULL
           AND t.status = 'inbox'",
        [],
        |r| r.get(0),
    )?;
    let done = completed_today
        .iter()
        .filter(|t| t.parent_id.is_none())
        .count() as i64;
    let open_today = (overdue.len() + due_today.len() + carried_over.len()) as i64;
    let pending = suggestions::pending_counts(conn)?
        .into_iter()
        .map(|(origin, count)| PendingCount { origin, count })
        .collect();
    let suggestions = suggestions::list(conn, Some(SuggestionStatus::Pending), 10)?;

    Ok(Dashboard {
        today,
        overdue,
        due_today,
        carried_over,
        due_soon,
        upcoming,
        recent,
        inbox_count,
        completed_today,
        progress: Progress {
            done,
            total: done + open_today,
        },
        pending,
        suggestions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::Db,
        model::{Actor, TaskInput, TaskOrigin, TaskStatus},
        repo::test_util::db,
    };
    use chrono::FixedOffset;

    fn clock() -> Clock {
        // 2026-11-23 10:30 in Ireland (UTC+0 in winter).
        let tz = FixedOffset::east_opt(0).unwrap();
        Clock::from_local(tz.with_ymd_and_hms(2026, 11, 23, 10, 30, 0).unwrap())
    }

    fn mk(
        db: &Db,
        title: &str,
        due: Option<&str>,
        time: Option<&str>,
        sched: Option<&str>,
    ) -> Task {
        db.write(|c| {
            tasks::create(
                c,
                &TaskInput {
                    title: title.into(),
                    due_date: due.map(Into::into),
                    due_time: time.map(Into::into),
                    scheduled_date: sched.map(Into::into),
                    ..Default::default()
                },
                &TaskOrigin::default(),
                Actor::User,
            )
        })
        .unwrap()
    }

    fn titles(v: &[Task]) -> Vec<&str> {
        v.iter().map(|t| t.title.as_str()).collect()
    }

    #[test]
    fn buckets() {
        let db = db();
        mk(&db, "late", Some("2026-11-20"), None, None);
        mk(&db, "late today", Some("2026-11-23"), Some("09:00"), None);
        mk(&db, "today later", Some("2026-11-23"), Some("15:00"), None);
        mk(&db, "today undated", None, None, Some("2026-11-23"));
        mk(&db, "carried", None, None, Some("2026-11-21"));
        mk(&db, "soon", Some("2026-11-26"), None, None);
        mk(&db, "upcoming", Some("2026-12-01"), None, None);
        mk(&db, "far", Some("2027-01-30"), None, None);
        // Planned today / earlier but due later: shown once (today / carried), not again as "soon".
        mk(
            &db,
            "planned today due soon",
            Some("2026-11-24"),
            None,
            Some("2026-11-23"),
        );
        mk(
            &db,
            "planned earlier due soon",
            Some("2026-11-25"),
            None,
            Some("2026-11-22"),
        );
        let done = mk(&db, "done", Some("2026-11-23"), None, None);
        db.write(|c| tasks::set_status(c, &done.id, TaskStatus::Completed, false, Actor::User))
            .unwrap();
        // Pin the completion time to the test clock's day (set_status stamps the real now).
        db.write(|c| {
            c.execute(
                "UPDATE tasks SET completed_at = '2026-11-23T09:00:00.000Z' WHERE id = ?1",
                [&done.id],
            )?;
            Ok(())
        })
        .unwrap();

        let d = db.read(|c| build(c, &clock())).unwrap();
        assert_eq!(titles(&d.overdue), ["late", "late today"]);
        assert_eq!(
            titles(&d.due_today),
            ["today later", "planned today due soon", "today undated"]
        );
        assert_eq!(
            titles(&d.carried_over),
            ["carried", "planned earlier due soon"]
        );
        assert_eq!(titles(&d.due_soon), ["soon"]);
        assert_eq!(titles(&d.upcoming), ["upcoming"]);
        assert_eq!(titles(&d.completed_today), ["done"]);
        assert_eq!(d.progress.done, 1);
        assert_eq!(d.progress.total, 1 + 2 + 3 + 2);
        assert_eq!(d.recent.len(), 10);
        // No task appears in two buckets.
        let mut seen = std::collections::HashSet::new();
        for t in d
            .overdue
            .iter()
            .chain(&d.due_today)
            .chain(&d.carried_over)
            .chain(&d.due_soon)
            .chain(&d.upcoming)
        {
            assert!(seen.insert(t.id.clone()), "{} listed twice", t.title);
        }
    }

    #[test]
    fn clock_day_bounds_in_utc() {
        let tz = FixedOffset::east_opt(2 * 3600).unwrap();
        let c = Clock::from_local(tz.with_ymd_and_hms(2026, 6, 1, 1, 0, 0).unwrap());
        assert_eq!(c.today.to_string(), "2026-06-01");
        assert_eq!(c.day_start_utc, "2026-05-31T22:00:00.000Z");
        assert_eq!(c.day_end_utc, "2026-06-01T22:00:00.000Z");
    }
}
