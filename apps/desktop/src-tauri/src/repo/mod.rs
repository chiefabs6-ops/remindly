//! Repositories: plain functions over a `&Connection`, so callers choose the transaction.

pub mod code_projects;
pub mod dashboard;
pub mod history;
pub mod meetings;
pub mod notes;
pub mod plan;
pub mod projects;
pub mod search;
pub mod settings;
pub mod similarity;
pub mod suggestions;
pub mod tags;
pub mod tasks;

#[cfg(test)]
pub(crate) mod test_util {
    use crate::db::Db;

    pub fn db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }
}
