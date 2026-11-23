//! "Plan my day" without AI: a deterministic order for today's work, with the reason for each.

use chrono::NaiveDate;
use serde::Serialize;

use crate::{model::Task, repo::dashboard::Dashboard};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub task: Task,
    pub reason: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayPlan {
    pub summary: String,
    pub items: Vec<PlanItem>,
}

fn days_late(due: &str, today: &str) -> i64 {
    match (
        NaiveDate::parse_from_str(due, "%Y-%m-%d"),
        NaiveDate::parse_from_str(today, "%Y-%m-%d"),
    ) {
        (Ok(d), Ok(t)) => (t - d).num_days(),
        _ => 0,
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Order: overdue (oldest first, then priority), timed tasks due today (by time), other tasks due
/// today (priority), carried over (priority), then high-priority work due in the next 3 days.
pub fn plan(d: &Dashboard, limit: usize) -> DayPlan {
    let mut items: Vec<PlanItem> = Vec::new();

    let mut overdue: Vec<&Task> = d.overdue.iter().collect();
    overdue.sort_by_key(|t| (t.due_date.clone(), std::cmp::Reverse(t.priority)));
    for t in overdue {
        let late = t
            .due_date
            .as_deref()
            .map(|x| days_late(x, &d.today))
            .unwrap_or(0);
        let reason = match (late, &t.due_time) {
            (0, Some(tm)) => format!("was due at {tm} today"),
            (1, _) => "1 day overdue".into(),
            (n, _) => format!("{n} days overdue"),
        };
        items.push(PlanItem {
            task: t.clone(),
            reason,
        });
    }

    let mut timed: Vec<&Task> = d
        .due_today
        .iter()
        .filter(|t| t.due_time.is_some())
        .collect();
    timed.sort_by_key(|t| t.due_time.clone());
    for t in timed {
        items.push(PlanItem {
            task: t.clone(),
            reason: format!("due at {}", t.due_time.clone().unwrap_or_default()),
        });
    }

    let mut untimed: Vec<&Task> = d
        .due_today
        .iter()
        .filter(|t| t.due_time.is_none())
        .collect();
    untimed.sort_by_key(|t| std::cmp::Reverse(t.priority));
    for t in untimed {
        let reason = if t.due_date.as_deref() == Some(d.today.as_str()) {
            "due today"
        } else {
            "planned for today"
        };
        let reason = if t.priority == 3 {
            format!("{reason}, high priority")
        } else {
            reason.to_string()
        };
        items.push(PlanItem {
            task: t.clone(),
            reason,
        });
    }

    let mut carried: Vec<&Task> = d.carried_over.iter().collect();
    carried.sort_by_key(|t| std::cmp::Reverse(t.priority));
    for t in carried {
        items.push(PlanItem {
            task: t.clone(),
            reason: "carried over from an earlier day".into(),
        });
    }

    for t in d.due_soon.iter().filter(|t| t.priority == 3) {
        items.push(PlanItem {
            task: t.clone(),
            reason: format!(
                "high priority, due {}",
                t.due_date.clone().unwrap_or_default()
            ),
        });
    }

    let total = items.len();
    items.truncate(limit);
    let summary = if total == 0 {
        if d.completed_today.is_empty() {
            "Nothing is due or overdue today.".to_string()
        } else {
            format!(
                "Everything for today is done ({}).",
                plural(d.completed_today.len(), "task", "tasks")
            )
        }
    } else {
        let mut parts = Vec::new();
        if !d.overdue.is_empty() {
            parts.push(format!("{} overdue", d.overdue.len()));
        }
        if !d.due_today.is_empty() {
            parts.push(format!("{} for today", d.due_today.len()));
        }
        if !d.carried_over.is_empty() {
            parts.push(format!("{} carried over", d.carried_over.len()));
        }
        let first = &items[0];
        format!(
            "{}. Start with “{}” ({}).",
            if parts.is_empty() {
                plural(total, "task to look at", "tasks to look at")
            } else {
                parts.join(", ")
            },
            first.task.title,
            first.reason
        )
    };
    DayPlan { summary, items }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{Actor, TaskInput, TaskOrigin},
        repo::{dashboard, tasks, test_util::db},
    };
    use chrono::{FixedOffset, TimeZone};

    fn mk(db: &crate::db::Db, title: &str, due: Option<&str>, time: Option<&str>, pri: u8) {
        db.write(|c| {
            tasks::create(
                c,
                &TaskInput {
                    title: title.into(),
                    due_date: due.map(Into::into),
                    due_time: time.map(Into::into),
                    priority: pri,
                    ..Default::default()
                },
                &TaskOrigin::default(),
                Actor::User,
            )
        })
        .unwrap();
    }

    #[test]
    fn orders_overdue_then_timed_then_priority() {
        let db = db();
        mk(&db, "Low today", Some("2026-11-23"), None, 1);
        mk(&db, "High today", Some("2026-11-23"), None, 3);
        mk(&db, "Call at 3", Some("2026-11-23"), Some("15:00"), 0);
        mk(&db, "Two days late", Some("2026-11-21"), None, 0);
        mk(&db, "Urgent soon", Some("2026-11-25"), None, 3);
        mk(&db, "Normal soon", Some("2026-11-25"), None, 0);
        let clock = dashboard::Clock::from_local(
            FixedOffset::east_opt(0)
                .unwrap()
                .with_ymd_and_hms(2026, 11, 23, 10, 0, 0)
                .unwrap(),
        );
        let d = db.read(|c| dashboard::build(c, &clock)).unwrap();
        let p = plan(&d, 10);
        let titles: Vec<_> = p.items.iter().map(|i| i.task.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "Two days late",
                "Call at 3",
                "High today",
                "Low today",
                "Urgent soon"
            ]
        );
        assert_eq!(p.items[0].reason, "2 days overdue");
        assert!(
            p.summary
                .starts_with("1 overdue, 3 for today. Start with “Two days late”"),
            "{}",
            p.summary
        );
    }

    #[test]
    fn empty_day() {
        let db = db();
        let clock = dashboard::Clock::from_local(
            FixedOffset::east_opt(0)
                .unwrap()
                .with_ymd_and_hms(2026, 11, 23, 10, 0, 0)
                .unwrap(),
        );
        let d = db.read(|c| dashboard::build(c, &clock)).unwrap();
        assert_eq!(plan(&d, 5).summary, "Nothing is due or overdue today.");
    }
}
