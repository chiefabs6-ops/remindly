use rusqlite::{Connection, OptionalExtension, Row, ToSql, params, params_from_iter};

use crate::{
    error::{AppError, AppResult},
    model::{
        Actor, Repeat, RepeatUnit, Source, Task, TaskDetail, TaskFilter, TaskInput, TaskOrigin,
        TaskStatus, clean_date, clean_priority, clean_text, clean_time, clean_title, new_id,
        now_utc,
    },
    repo::{history, links, search, tags},
};

pub(crate) const COLS: &str = "t.id, t.parent_id, t.project_id, t.title, t.description, t.notes,
    t.status, t.priority, t.due_date, t.due_time, t.scheduled_date, t.source, t.source_url,
    t.source_title, t.source_selection, t.code_project_id, t.note_id, t.sort_order,
    t.completed_at, t.archived_at, t.created_at, t.updated_at, t.deleted_at,
    (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL),
    (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL
        AND s.status = 'completed'),
    (SELECT group_concat(g.name, char(31)) FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
        WHERE tt.task_id = t.id),
    t.reminder_lead, t.reminder_repeat, t.claude_context,
    (SELECT min(r.fire_at) FROM reminders r WHERE r.task_id = t.id AND r.kind = 'custom'
        AND r.fired_at IS NULL AND r.dismissed_at IS NULL),
    (SELECT min(r.fire_at) FROM reminders r WHERE r.task_id = t.id AND r.kind = 'snooze'
        AND r.fired_at IS NULL AND r.dismissed_at IS NULL),
    t.repeat_every, t.repeat_unit, t.repeat_next_id";

/// Default list order: dated first by date/time, then priority, manual order, age.
pub(crate) const ORDER: &str = "ORDER BY (t.due_date IS NULL), t.due_date, (t.due_time IS NULL),
    t.due_time, t.priority DESC, t.sort_order, t.created_at";

pub(crate) fn from_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        project_id: r.get(2)?,
        title: r.get(3)?,
        description: r.get(4)?,
        notes: r.get(5)?,
        status: r.get(6)?,
        priority: r.get(7)?,
        due_date: r.get(8)?,
        due_time: r.get(9)?,
        scheduled_date: r.get(10)?,
        source: r.get(11)?,
        source_url: r.get(12)?,
        source_title: r.get(13)?,
        source_selection: r.get(14)?,
        code_project_id: r.get(15)?,
        note_id: r.get(16)?,
        sort_order: r.get(17)?,
        completed_at: r.get(18)?,
        archived_at: r.get(19)?,
        created_at: r.get(20)?,
        updated_at: r.get(21)?,
        deleted_at: r.get(22)?,
        subtask_count: r.get(23)?,
        subtask_done: r.get(24)?,
        tags: tags::split_joined(r.get(25)?),
        reminder_lead: r.get(26)?,
        reminder_repeat: r.get::<_, i64>(27)? != 0,
        claude_context: r
            .get::<_, Option<String>>(28)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        next_reminder: r.get(29)?,
        snoozed_until: r.get(30)?,
        repeat: match (
            r.get::<_, Option<u32>>(31)?,
            r.get::<_, Option<String>>(32)?
                .as_deref()
                .and_then(RepeatUnit::parse),
        ) {
            (Some(every), Some(unit)) => Some(Repeat { every, unit }),
            _ => None,
        },
        repeat_next_id: r.get(33)?,
    })
}

/// Validated, normalised form of `TaskInput`.
struct Clean {
    title: String,
    description: Option<String>,
    notes: Option<String>,
    priority: u8,
    due_date: Option<String>,
    due_time: Option<String>,
    scheduled_date: Option<String>,
    project_id: Option<String>,
}

fn clean(input: &TaskInput) -> AppResult<Clean> {
    let due_date = clean_date("due date", &input.due_date)?;
    let due_time = clean_time("due time", &input.due_time)?;
    if due_time.is_some() && due_date.is_none() {
        return Err(AppError::invalid("a due time needs a due date"));
    }
    Ok(Clean {
        title: clean_title(&input.title)?,
        description: clean_text("description", &input.description)?,
        notes: clean_text("notes", &input.notes)?,
        priority: clean_priority(input.priority)?,
        due_date,
        due_time,
        scheduled_date: clean_date("scheduled date", &input.scheduled_date)?,
        project_id: clean_text("project", &input.project_id)?,
    })
}

/// Includes soft-deleted tasks.
pub fn get_any(conn: &Connection, id: &str) -> AppResult<Task> {
    conn.query_row(
        &format!("SELECT {COLS} FROM tasks t WHERE t.id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("task".into()))
}

/// Live (not deleted) task.
pub fn get(conn: &Connection, id: &str) -> AppResult<Task> {
    let t = get_any(conn, id)?;
    if t.deleted_at.is_some() {
        return Err(AppError::NotFound("task".into()));
    }
    Ok(t)
}

pub fn detail(conn: &Connection, id: &str) -> AppResult<TaskDetail> {
    let task = get(conn, id)?;
    let subtasks = list(
        conn,
        &TaskFilter {
            parent_id: Some(id.to_string()),
            limit: Some(500),
            ..Default::default()
        },
    )?;
    let history = history::list(conn, id)?;
    let links = links::list(conn, id)?;
    Ok(TaskDetail {
        task,
        subtasks,
        history,
        links,
    })
}

/// Per-task reminder: `lead` None = app default, 0..=1440 minutes before the due time,
/// -1 = the morning of the due day. `repeat` = once overdue, every working morning until done.
pub fn set_reminder(
    conn: &Connection,
    id: &str,
    lead: Option<i64>,
    repeat: bool,
    actor: Actor,
) -> AppResult<Task> {
    if let Some(l) = lead
        && l != -1
        && !(0..=1440).contains(&l)
    {
        return Err(AppError::invalid(
            "reminder must be 0-1440 minutes before, or the morning of",
        ));
    }
    let old = get(conn, id)?;
    conn.execute(
        "UPDATE tasks SET reminder_lead = ?2, reminder_repeat = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, lead, repeat as i64, now_utc()],
    )?;
    let show = |l: Option<i64>, r: bool| {
        let base = match l {
            None => "default".to_string(),
            Some(-1) => "morning of".to_string(),
            Some(m) => format!("{m} min before"),
        };
        if r {
            format!("{base}, repeat until done")
        } else {
            base
        }
    };
    let (before, after) = (
        show(old.reminder_lead, old.reminder_repeat),
        show(lead, repeat),
    );
    if before != after {
        history::record(
            conn,
            id,
            actor,
            "update",
            Some("reminder"),
            Some(&before),
            Some(&after),
        )?;
    }
    get(conn, id)
}

/// Make a task repeat (or stop it). Subtasks cannot repeat: their parent can.
pub fn set_repeat(
    conn: &Connection,
    id: &str,
    repeat: Option<Repeat>,
    actor: Actor,
) -> AppResult<Task> {
    let old = get(conn, id)?;
    if let Some(r) = repeat {
        if !(1..=Repeat::MAX_EVERY).contains(&r.every) {
            return Err(AppError::invalid("repeat must be every 1-365"));
        }
        if old.parent_id.is_some() {
            return Err(AppError::invalid(
                "a subtask cannot repeat; make its parent task repeat",
            ));
        }
    }
    if old.repeat == repeat {
        return Ok(old);
    }
    conn.execute(
        "UPDATE tasks SET repeat_every = ?2, repeat_unit = ?3, updated_at = ?4 WHERE id = ?1",
        params![
            id,
            repeat.map(|r| r.every),
            repeat.map(|r| r.unit.as_str()),
            now_utc()
        ],
    )?;
    let show = |r: Option<Repeat>| r.map_or_else(|| "does not repeat".to_string(), Repeat::label);
    history::record(
        conn,
        id,
        actor,
        "update",
        Some("repeat"),
        Some(&show(old.repeat)),
        Some(&show(repeat)),
    )?;
    get(conn, id)
}

/// Completing a repeating task: create the next copy (subtasks reset), due `repeat` after `today`.
/// Keeps the due time, project, tags, priority, description, notes and reminder settings.
fn spawn_next(
    conn: &Connection,
    done: &Task,
    repeat: Repeat,
    today: chrono::NaiveDate,
    actor: Actor,
) -> AppResult<String> {
    let copy = duplicate_inner(conn, done, None, false, actor)?;
    let due = repeat.next_due(today).format("%Y-%m-%d").to_string();
    // updated_at stays equal to created_at: "untouched", so an undo can remove it again.
    conn.execute(
        "UPDATE tasks SET due_date = ?2, scheduled_date = NULL, repeat_every = ?3, repeat_unit = ?4,
            reminder_lead = ?5, reminder_repeat = ?6, claude_context = ?7, updated_at = created_at
         WHERE id = ?1",
        params![
            copy.id,
            due,
            repeat.every,
            repeat.unit.as_str(),
            done.reminder_lead,
            done.reminder_repeat as i64,
            done.claude_context.as_ref().map(|v| v.to_string()),
        ],
    )?;
    history::record(
        conn,
        &copy.id,
        actor,
        "repeated",
        None,
        Some(&done.id),
        Some(&due),
    )?;
    conn.execute(
        "UPDATE tasks SET repeat_next_id = ?2 WHERE id = ?1",
        params![done.id, copy.id],
    )?;
    Ok(copy.id)
}

/// Manual order from drag and drop: `ids` in their new order. The list still sorts by due date
/// first, so the UI only reorders tasks that share a date group.
pub fn reorder(conn: &Connection, ids: &[String]) -> AppResult<()> {
    for (i, id) in ids.iter().enumerate() {
        let n = conn.execute(
            "UPDATE tasks SET sort_order = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, i as f64],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("task".into()));
        }
    }
    Ok(())
}

pub fn create(
    conn: &Connection,
    input: &TaskInput,
    origin: &TaskOrigin,
    actor: Actor,
) -> AppResult<Task> {
    let c = clean(input)?;
    let parent_id = clean_text("parent", &origin.parent_id)?;
    let mut project_id = c.project_id.clone();
    if let Some(pid) = &parent_id {
        let parent = get(conn, pid)?;
        if project_id.is_none() {
            project_id = parent.project_id;
        }
    }
    let status = input.status.unwrap_or(TaskStatus::NotStarted);
    let id = new_id();
    let now = now_utc();
    let sort_order: f64 = conn.query_row(
        "SELECT coalesce(max(sort_order), 0) + 1 FROM tasks WHERE parent_id IS ?1",
        [&parent_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO tasks(id, parent_id, project_id, title, description, notes, status, priority,
            due_date, due_time, scheduled_date, source, source_url, source_title, source_selection,
            code_project_id, note_id, sort_order, completed_at, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, ?21)",
        params![
            id,
            parent_id,
            project_id,
            c.title,
            c.description,
            c.notes,
            status,
            c.priority,
            c.due_date,
            c.due_time,
            c.scheduled_date,
            origin.source.unwrap_or(Source::Manual),
            clean_text("source url", &origin.source_url)?,
            clean_text("source title", &origin.source_title)?,
            clean_text("selection", &origin.source_selection)?,
            clean_text("code project", &origin.code_project_id)?,
            clean_text("note", &origin.note_id)?,
            sort_order,
            (status == TaskStatus::Completed).then(|| now.clone()),
            (status == TaskStatus::Archived).then(|| now.clone()),
            now,
        ],
    )?;
    tags::set_for_task(conn, &id, &input.tags)?;
    history::record(conn, &id, actor, "created", None, None, Some(&c.title))?;
    get(conn, &id)
}

/// Timestamps that follow a status change.
fn status_stamps(
    old: &Task,
    new_status: TaskStatus,
    now: &str,
) -> (Option<String>, Option<String>) {
    let completed_at = match (old.status, new_status) {
        (TaskStatus::Completed, TaskStatus::Completed) => old.completed_at.clone(),
        (_, TaskStatus::Completed) => Some(now.to_string()),
        _ => None,
    };
    let archived_at = match (old.status, new_status) {
        (TaskStatus::Archived, TaskStatus::Archived) => old.archived_at.clone(),
        (_, TaskStatus::Archived) => Some(now.to_string()),
        _ => None,
    };
    (completed_at, archived_at)
}

/// Full update (PUT): every editable field is replaced. Writes one history row per changed field.
pub fn update(conn: &Connection, id: &str, input: &TaskInput, actor: Actor) -> AppResult<Task> {
    let old = get(conn, id)?;
    let c = clean(input)?;
    if let Some(pid) = &c.project_id {
        // Clear error instead of a raw FK failure.
        crate::repo::projects::get(conn, pid)?;
    }
    let status = input.status.unwrap_or(old.status);
    let now = now_utc();
    let (completed_at, archived_at) = status_stamps(&old, status, &now);
    conn.execute(
        "UPDATE tasks SET title = ?2, description = ?3, notes = ?4, status = ?5, priority = ?6,
            due_date = ?7, due_time = ?8, scheduled_date = ?9, project_id = ?10,
            completed_at = ?11, archived_at = ?12, updated_at = ?13
         WHERE id = ?1",
        params![
            id,
            c.title,
            c.description,
            c.notes,
            status,
            c.priority,
            c.due_date,
            c.due_time,
            c.scheduled_date,
            c.project_id,
            completed_at,
            archived_at,
            now
        ],
    )?;
    let new_tags = tags::set_for_task(conn, id, &input.tags)?;

    let p = |v: u8| v.to_string();
    let changes: [(&str, Option<String>, Option<String>); 10] = [
        ("title", Some(old.title.clone()), Some(c.title.clone())),
        (
            "description",
            old.description.clone(),
            c.description.clone(),
        ),
        ("notes", old.notes.clone(), c.notes.clone()),
        (
            "status",
            Some(old.status.as_str().into()),
            Some(status.as_str().into()),
        ),
        ("priority", Some(p(old.priority)), Some(p(c.priority))),
        ("due_date", old.due_date.clone(), c.due_date.clone()),
        ("due_time", old.due_time.clone(), c.due_time.clone()),
        (
            "scheduled_date",
            old.scheduled_date.clone(),
            c.scheduled_date.clone(),
        ),
        ("project_id", old.project_id.clone(), c.project_id.clone()),
        ("tags", Some(old.tags.join(", ")), {
            let mut t = new_tags.clone();
            t.sort_by_key(|s| s.to_lowercase());
            Some(t.join(", "))
        }),
    ];
    for (field, before, after) in changes {
        if before != after {
            history::record(
                conn,
                id,
                actor,
                "updated",
                Some(field),
                before.as_deref(),
                after.as_deref(),
            )?;
        }
    }
    get(conn, id)
}

/// Change status only. With `cascade`, completing/archiving also applies to open subtasks.
pub fn set_status(
    conn: &Connection,
    id: &str,
    status: TaskStatus,
    cascade: bool,
    actor: Actor,
) -> AppResult<Task> {
    let old = get(conn, id)?;
    if old.status != status {
        let now = now_utc();
        let (completed_at, archived_at) = status_stamps(&old, status, &now);
        conn.execute(
            "UPDATE tasks SET status = ?2, completed_at = ?3, archived_at = ?4, updated_at = ?5
             WHERE id = ?1",
            params![id, status, completed_at, archived_at, now],
        )?;
        history::record(
            conn,
            id,
            actor,
            "status",
            Some("status"),
            Some(old.status.as_str()),
            Some(status.as_str()),
        )?;
    }
    if old.status != status && old.parent_id.is_none() {
        let next = old
            .repeat_next_id
            .as_deref()
            .and_then(|n| get(conn, n).ok());
        if status == TaskStatus::Completed {
            if let Some(r) = old.repeat
                && next.is_none()
            {
                spawn_next(conn, &old, r, chrono::Local::now().date_naive(), actor)?;
            }
        } else if old.status == TaskStatus::Completed
            && let Some(n) = next
            && n.status == TaskStatus::NotStarted
            && n.updated_at == n.created_at
        {
            // Reopened (e.g. undo): the copy made on completion was never touched, so take it back.
            soft_delete(conn, &n.id, actor)?;
            conn.execute(
                "UPDATE tasks SET repeat_next_id = NULL WHERE id = ?1",
                params![id],
            )?;
        }
    }
    if cascade && matches!(status, TaskStatus::Completed | TaskStatus::Archived) {
        let open: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL AND status != ?2",
            )?;
            stmt.query_map(params![id, status], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        };
        for sub in open {
            set_status(conn, &sub, status, true, actor)?;
        }
    }
    get(conn, id)
}

/// Move the due date (and optionally time). `None` clears it.
pub fn reschedule(
    conn: &Connection,
    id: &str,
    due_date: Option<String>,
    due_time: Option<String>,
    actor: Actor,
) -> AppResult<Task> {
    let old = get(conn, id)?;
    let input = TaskInput {
        due_date,
        due_time,
        ..to_input(&old)
    };
    update(conn, id, &input, actor)
}

/// Set the "do on" date (used by carry-forward / end-of-day review).
pub fn schedule(
    conn: &Connection,
    id: &str,
    scheduled_date: Option<String>,
    actor: Actor,
) -> AppResult<Task> {
    let old = get(conn, id)?;
    let input = TaskInput {
        scheduled_date,
        ..to_input(&old)
    };
    update(conn, id, &input, actor)
}

pub fn to_input(t: &Task) -> TaskInput {
    TaskInput {
        title: t.title.clone(),
        description: t.description.clone(),
        notes: t.notes.clone(),
        status: Some(t.status),
        priority: t.priority,
        due_date: t.due_date.clone(),
        due_time: t.due_time.clone(),
        scheduled_date: t.scheduled_date.clone(),
        project_id: t.project_id.clone(),
        tags: t.tags.clone(),
    }
}

/// Copy a task (and its live subtasks) as a fresh, not-started task.
pub fn duplicate(conn: &Connection, id: &str, actor: Actor) -> AppResult<Task> {
    let src = get(conn, id)?;
    let copy = duplicate_inner(conn, &src, src.parent_id.clone(), true, actor)?;
    history::record(
        conn,
        &copy.id,
        actor,
        "duplicated",
        None,
        Some(&src.id),
        None,
    )?;
    get(conn, &copy.id)
}

fn duplicate_inner(
    conn: &Connection,
    src: &Task,
    parent_id: Option<String>,
    rename: bool,
    actor: Actor,
) -> AppResult<Task> {
    let mut input = to_input(src);
    input.status = Some(TaskStatus::NotStarted);
    if rename {
        let mut t = format!("{} (copy)", src.title);
        if t.chars().count() > crate::model::MAX_TITLE {
            t = src.title.clone();
        }
        input.title = t;
    }
    let origin = TaskOrigin {
        parent_id,
        source: Some(src.source),
        source_url: src.source_url.clone(),
        source_title: src.source_title.clone(),
        source_selection: src.source_selection.clone(),
        code_project_id: src.code_project_id.clone(),
        note_id: src.note_id.clone(),
    };
    let copy = create(conn, &input, &origin, actor)?;
    let subs = list(
        conn,
        &TaskFilter {
            parent_id: Some(src.id.clone()),
            limit: Some(500),
            ..Default::default()
        },
    )?;
    for s in subs {
        duplicate_inner(conn, &s, Some(copy.id.clone()), false, actor)?;
    }
    Ok(copy)
}

/// Soft delete the task and its subtasks (recoverable until purged).
pub fn soft_delete(conn: &Connection, id: &str, actor: Actor) -> AppResult<()> {
    get(conn, id)?;
    let now = now_utc();
    conn.execute(
        "WITH RECURSIVE tree(id) AS (
            SELECT ?1 UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
         UPDATE tasks SET deleted_at = ?2, updated_at = ?2
         WHERE id IN tree AND deleted_at IS NULL",
        params![id, now],
    )?;
    history::record(conn, id, actor, "deleted", None, None, None)?;
    Ok(())
}

pub fn restore(conn: &Connection, id: &str, actor: Actor) -> AppResult<Task> {
    let t = get_any(conn, id)?;
    let Some(deleted_at) = t.deleted_at else {
        return Ok(t);
    };
    // Restore the subtree that was deleted together with it.
    conn.execute(
        "WITH RECURSIVE tree(id) AS (
            SELECT ?1 UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
         UPDATE tasks SET deleted_at = NULL, updated_at = ?3
         WHERE id IN tree AND deleted_at = ?2",
        params![id, deleted_at, now_utc()],
    )?;
    history::record(conn, id, actor, "restored", None, None, None)?;
    get(conn, id)
}

/// Permanently remove tasks soft-deleted before `before` (RFC 3339). Returns rows removed.
pub fn purge_deleted(conn: &Connection, before: &str) -> AppResult<usize> {
    // Count first: SQLite's change count excludes rows removed by ON DELETE CASCADE.
    let total: i64 = conn.query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))?;
    conn.execute(
        "DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [before],
    )?;
    let left: i64 = conn.query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))?;
    Ok((total - left) as usize)
}

pub fn list(conn: &Connection, f: &TaskFilter) -> AppResult<Vec<Task>> {
    let mut wheres: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    let arg = |v: Box<dyn ToSql>, args: &mut Vec<Box<dyn ToSql>>| {
        args.push(v);
        format!("?{}", args.len())
    };

    if !f.include_deleted {
        wheres.push("t.deleted_at IS NULL".into());
    }
    if !f.statuses.is_empty() {
        let ph: Vec<String> = f
            .statuses
            .iter()
            .map(|s| arg(Box::new(*s), &mut args))
            .collect();
        wheres.push(format!("t.status IN ({})", ph.join(",")));
    }
    if let Some(p) = &f.project_id {
        let a = arg(Box::new(p.clone()), &mut args);
        wheres.push(format!("t.project_id = {a}"));
    } else if f.no_project {
        wheres.push("t.project_id IS NULL".into());
    }
    if let Some(tag) = &f.tag {
        let a = arg(
            Box::new(tag.trim().trim_start_matches('#').to_string()),
            &mut args,
        );
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
               WHERE tt.task_id = t.id AND g.name = {a} COLLATE NOCASE)"
        ));
    }
    if let Some(parent) = &f.parent_id {
        let a = arg(Box::new(parent.clone()), &mut args);
        wheres.push(format!("t.parent_id = {a}"));
    } else if f.top_level_only {
        wheres.push("t.parent_id IS NULL".into());
    }
    if let Some(from) = clean_date("due from", &f.due_from)? {
        let a = arg(Box::new(from), &mut args);
        wheres.push(format!("t.due_date >= {a}"));
    }
    if let Some(to) = clean_date("due to", &f.due_to)? {
        let a = arg(Box::new(to), &mut args);
        wheres.push(format!("t.due_date <= {a}"));
    }
    if let Some(src) = f.source {
        let a = arg(Box::new(src), &mut args);
        wheres.push(format!("t.source = {a}"));
    }
    if let Some(q) = f.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        if search::uses_fts(q) {
            let a = arg(Box::new(search::fts_phrase(q)), &mut args);
            wheres.push(format!(
                "t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH {a})"
            ));
        } else {
            let a = arg(Box::new(search::like_pattern(q)), &mut args);
            wheres.push(format!(
                "(t.title LIKE {a} ESCAPE '\\' OR t.description LIKE {a} ESCAPE '\\'
                  OR t.notes LIKE {a} ESCAPE '\\')"
            ));
        }
    }
    let limit = f.limit.unwrap_or(500).clamp(1, 2000);
    let sql = format!(
        "SELECT {COLS} FROM tasks t {} {ORDER} LIMIT {limit}",
        if wheres.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", wheres.join(" AND "))
        }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter().map(|b| b.as_ref())), from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::ProjectInput, repo::projects, repo::test_util::db};

    fn input(title: &str) -> TaskInput {
        TaskInput {
            title: title.into(),
            ..Default::default()
        }
    }

    fn mk(db: &crate::db::Db, title: &str) -> Task {
        db.write(|c| create(c, &input(title), &TaskOrigin::default(), Actor::User))
            .unwrap()
    }

    #[test]
    fn create_validates_and_defaults() {
        let db = db();
        let t = mk(&db, "  Write report ");
        assert_eq!(t.title, "Write report");
        assert_eq!(t.status, TaskStatus::NotStarted);
        assert_eq!(t.source, Source::Manual);
        assert!(t.completed_at.is_none());

        let bad_time = TaskInput {
            due_time: Some("10:00".into()),
            ..input("x")
        };
        assert!(
            db.write(|c| create(c, &bad_time, &TaskOrigin::default(), Actor::User))
                .is_err()
        );
        let bad_project = TaskInput {
            project_id: Some("nope".into()),
            ..input("x")
        };
        assert!(matches!(
            db.write(|c| create(c, &bad_project, &TaskOrigin::default(), Actor::User)),
            Err(AppError::Invalid(_))
        ));
        // Failed creates leave nothing behind.
        assert_eq!(
            db.read(|c| list(c, &TaskFilter::default())).unwrap().len(),
            1
        );
    }

    #[test]
    fn update_records_history_and_tags() {
        let db = db();
        let t = mk(&db, "Draft");
        let changed = TaskInput {
            title: "Final".into(),
            priority: 3,
            due_date: Some("2026-12-01".into()),
            tags: vec!["Work".into(), "#urgent".into()],
            ..to_input(&t)
        };
        let u = db
            .write(|c| update(c, &t.id, &changed, Actor::User))
            .unwrap();
        assert_eq!(u.title, "Final");
        assert_eq!(u.tags, ["urgent", "Work"]);
        let d = db.read(|c| detail(c, &t.id)).unwrap();
        let fields: Vec<_> = d.history.iter().filter_map(|h| h.field.clone()).collect();
        for f in ["title", "priority", "due_date", "tags"] {
            assert!(fields.contains(&f.to_string()), "missing history for {f}");
        }
        assert!(!fields.contains(&"notes".to_string()));
    }

    #[test]
    fn complete_cascades_and_reopen_clears_timestamp() {
        let db = db();
        let parent = mk(&db, "Parent");
        let sub = db
            .write(|c| {
                create(
                    c,
                    &input("Sub"),
                    &TaskOrigin {
                        parent_id: Some(parent.id.clone()),
                        ..Default::default()
                    },
                    Actor::User,
                )
            })
            .unwrap();
        let p = db
            .write(|c| set_status(c, &parent.id, TaskStatus::Completed, true, Actor::User))
            .unwrap();
        assert!(p.completed_at.is_some());
        assert_eq!(p.subtask_done, 1);
        assert_eq!(
            db.read(|c| get(c, &sub.id)).unwrap().status,
            TaskStatus::Completed
        );

        let reopened = db
            .write(|c| set_status(c, &parent.id, TaskStatus::InProgress, true, Actor::User))
            .unwrap();
        assert!(reopened.completed_at.is_none());
    }

    #[test]
    fn subtask_inherits_project() {
        let db = db();
        let proj = db
            .write(|c| {
                projects::create(
                    c,
                    &ProjectInput {
                        name: "P".into(),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
        let parent = db
            .write(|c| {
                create(
                    c,
                    &TaskInput {
                        project_id: Some(proj.id.clone()),
                        ..input("Parent")
                    },
                    &TaskOrigin::default(),
                    Actor::User,
                )
            })
            .unwrap();
        let sub = db
            .write(|c| {
                create(
                    c,
                    &input("Sub"),
                    &TaskOrigin {
                        parent_id: Some(parent.id.clone()),
                        ..Default::default()
                    },
                    Actor::User,
                )
            })
            .unwrap();
        assert_eq!(sub.project_id, Some(proj.id));
    }

    #[test]
    fn duplicate_copies_subtasks_as_new() {
        let db = db();
        let parent = mk(&db, "Trip");
        db.write(|c| {
            create(
                c,
                &TaskInput {
                    status: Some(TaskStatus::Completed),
                    ..input("Book hotel")
                },
                &TaskOrigin {
                    parent_id: Some(parent.id.clone()),
                    ..Default::default()
                },
                Actor::User,
            )
        })
        .unwrap();
        let copy = db.write(|c| duplicate(c, &parent.id, Actor::User)).unwrap();
        assert_eq!(copy.title, "Trip (copy)");
        assert_eq!(copy.subtask_count, 1);
        assert_eq!(copy.subtask_done, 0);
        assert_ne!(copy.id, parent.id);
    }

    #[test]
    fn soft_delete_restore_purge() {
        let db = db();
        let parent = mk(&db, "Parent");
        let sub = db
            .write(|c| {
                create(
                    c,
                    &input("Sub"),
                    &TaskOrigin {
                        parent_id: Some(parent.id.clone()),
                        ..Default::default()
                    },
                    Actor::User,
                )
            })
            .unwrap();
        db.write(|c| soft_delete(c, &parent.id, Actor::User))
            .unwrap();
        assert!(matches!(
            db.read(|c| get(c, &sub.id)),
            Err(AppError::NotFound(_))
        ));
        assert!(
            db.read(|c| list(c, &TaskFilter::default()))
                .unwrap()
                .is_empty()
        );

        db.write(|c| restore(c, &parent.id, Actor::User)).unwrap();
        assert!(db.read(|c| get(c, &sub.id)).is_ok());

        db.write(|c| soft_delete(c, &parent.id, Actor::User))
            .unwrap();
        let removed = db
            .write(|c| purge_deleted(c, "9999-01-01T00:00:00.000Z"))
            .unwrap();
        assert_eq!(removed, 2);
    }

    #[test]
    fn list_filters_and_search() {
        let db = db();
        let a = mk(&db, "Follow up with Niamh about SEPI list");
        mk(&db, "Book dentist");
        db.write(|c| reschedule(c, &a.id, Some("2026-12-05".into()), None, Actor::User))
            .unwrap();

        let q = |s: &str| {
            db.read(|c| {
                list(
                    c,
                    &TaskFilter {
                        query: Some(s.into()),
                        ..Default::default()
                    },
                )
            })
            .unwrap()
            .len()
        };
        assert_eq!(q("niamh"), 1, "case-insensitive word");
        assert_eq!(q("SEP"), 1, "substring via trigram");
        assert_eq!(q("de"), 1, "short query falls back to LIKE (dentist)");
        assert_eq!(q("\"OR"), 0, "FTS syntax is escaped");

        let due = db
            .read(|c| {
                list(
                    c,
                    &TaskFilter {
                        due_from: Some("2026-12-01".into()),
                        due_to: Some("2026-12-31".into()),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
        assert_eq!(due.len(), 1);
        // Dated tasks sort before undated ones.
        let all = db.read(|c| list(c, &TaskFilter::default())).unwrap();
        assert_eq!(all[0].id, a.id);
    }

    #[test]
    fn search_tracks_title_edits() {
        let db = db();
        let t = mk(&db, "Alpha task");
        db.write(|c| {
            update(
                c,
                &t.id,
                &TaskInput {
                    title: "Bravo task".into(),
                    ..to_input(&t)
                },
                Actor::User,
            )
        })
        .unwrap();
        let find = |s: &str| {
            db.read(|c| {
                list(
                    c,
                    &TaskFilter {
                        query: Some(s.into()),
                        ..Default::default()
                    },
                )
            })
            .unwrap()
            .len()
        };
        assert_eq!(find("Alpha"), 0);
        assert_eq!(find("Bravo"), 1);
    }

    #[test]
    fn reorder_sets_manual_order_and_rejects_unknown_ids() {
        let db = db();
        let a = mk(&db, "A");
        let b = mk(&db, "B");
        db.write(|c| reorder(c, &[b.id.clone(), a.id.clone()]))
            .unwrap();
        let ta = db.read(|c| get(c, &a.id)).unwrap();
        let tb = db.read(|c| get(c, &b.id)).unwrap();
        assert!(tb.sort_order < ta.sort_order);
        assert!(db.write(|c| reorder(c, &["nope".into()])).is_err());
        let d = db.read(|c| detail(c, &a.id)).unwrap();
        assert!(d.links.is_empty());
    }

    #[test]
    fn repeat_next_due_dates() {
        let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let r = |every, unit| Repeat { every, unit };
        // Wednesday 2026-11-25.
        assert_eq!(
            r(1, RepeatUnit::Day).next_due(d("2026-11-25")),
            d("2026-11-26")
        );
        assert_eq!(
            r(2, RepeatUnit::Week).next_due(d("2026-11-25")),
            d("2026-12-09")
        );
        assert_eq!(
            r(1, RepeatUnit::Month).next_due(d("2026-01-31")),
            d("2026-02-28")
        );
        assert_eq!(
            r(3, RepeatUnit::Month).next_due(d("2026-11-25")),
            d("2027-02-25")
        );
        // Friday + 1 working day = Monday; Friday + 3 working days = Wednesday.
        assert_eq!(
            r(1, RepeatUnit::Weekday).next_due(d("2026-11-27")),
            d("2026-11-30")
        );
        assert_eq!(
            r(3, RepeatUnit::Weekday).next_due(d("2026-11-27")),
            d("2026-12-02")
        );
        assert_eq!(r(2, RepeatUnit::Week).label(), "every 2 weeks");
        assert_eq!(r(1, RepeatUnit::Weekday).label(), "every working day");
    }

    #[test]
    fn completing_a_repeating_task_makes_the_next_one() {
        let db = db();
        let t = db
            .write(|c| {
                create(
                    c,
                    &TaskInput {
                        title: "Expense claims".into(),
                        due_date: Some("2026-11-20".into()),
                        due_time: Some("09:30".into()),
                        priority: 2,
                        tags: vec!["admin".into()],
                        ..Default::default()
                    },
                    &TaskOrigin::default(),
                    Actor::User,
                )
            })
            .unwrap();
        let sub = db
            .write(|c| {
                create(
                    c,
                    &input("Collect receipts"),
                    &TaskOrigin {
                        parent_id: Some(t.id.clone()),
                        ..Default::default()
                    },
                    Actor::User,
                )
            })
            .unwrap();
        let weekly = Repeat {
            every: 1,
            unit: RepeatUnit::Week,
        };
        // Subtasks cannot repeat, and the range is checked.
        assert!(
            db.write(|c| set_repeat(c, &sub.id, Some(weekly), Actor::User))
                .is_err()
        );
        assert!(
            db.write(|c| set_repeat(
                c,
                &t.id,
                Some(Repeat {
                    every: 0,
                    unit: RepeatUnit::Day
                }),
                Actor::User
            ))
            .is_err()
        );
        let t = db
            .write(|c| set_repeat(c, &t.id, Some(weekly), Actor::User))
            .unwrap();
        assert_eq!(t.repeat, Some(weekly));

        let done = db
            .write(|c| set_status(c, &t.id, TaskStatus::Completed, true, Actor::User))
            .unwrap();
        let next_id = done.repeat_next_id.clone().expect("next copy made");
        let next = db.read(|c| detail(c, &next_id)).unwrap();
        let want = weekly
            .next_due(chrono::Local::now().date_naive())
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(next.task.title, "Expense claims");
        assert_eq!(next.task.status, TaskStatus::NotStarted);
        assert_eq!(next.task.due_date.as_deref(), Some(want.as_str()));
        assert_eq!(next.task.due_time.as_deref(), Some("09:30"));
        assert_eq!(next.task.priority, 2);
        assert_eq!(next.task.tags, vec!["admin".to_string()]);
        assert_eq!(next.task.repeat, Some(weekly));
        assert_eq!(next.subtasks.len(), 1);
        assert_eq!(next.subtasks[0].status, TaskStatus::NotStarted);

        // Completing again (already completed) makes no second copy.
        db.write(|c| set_status(c, &t.id, TaskStatus::Completed, true, Actor::User))
            .unwrap();
        // Undo: reopening takes the untouched copy back.
        let reopened = db
            .write(|c| set_status(c, &t.id, TaskStatus::NotStarted, false, Actor::User))
            .unwrap();
        assert!(reopened.repeat_next_id.is_none());
        assert!(db.read(|c| get(c, &next_id)).is_err());

        // Complete, then edit the copy: reopening keeps it, and completing again makes no extra copy.
        let done = db
            .write(|c| set_status(c, &t.id, TaskStatus::Completed, true, Actor::User))
            .unwrap();
        let second = done.repeat_next_id.clone().unwrap();
        assert_ne!(second, next_id);
        db.write(|c| {
            Ok(c.execute(
                "UPDATE tasks SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1",
                [&second],
            )?)
        })
        .unwrap();
        db.write(|c| set_status(c, &t.id, TaskStatus::NotStarted, false, Actor::User))
            .unwrap();
        assert!(db.read(|c| get(c, &second)).is_ok());
        let again = db
            .write(|c| set_status(c, &t.id, TaskStatus::Completed, true, Actor::User))
            .unwrap();
        assert_eq!(again.repeat_next_id.as_deref(), Some(second.as_str()));

        // A task that does not repeat makes nothing.
        let plain = mk(&db, "One-off");
        let plain = db
            .write(|c| set_status(c, &plain.id, TaskStatus::Completed, true, Actor::User))
            .unwrap();
        assert!(plain.repeat_next_id.is_none());

        // Stop repeating.
        let t = db
            .write(|c| set_repeat(c, &second, None, Actor::User))
            .unwrap();
        assert!(t.repeat.is_none());
    }
}
