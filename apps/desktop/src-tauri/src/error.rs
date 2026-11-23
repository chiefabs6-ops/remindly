use serde::{Serialize, Serializer, ser::SerializeStruct};

/// Error type shared by the data layer, Tauri commands and the HTTP API.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0} not found")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Conflict(String),
    #[error("database error: {0}")]
    Db(rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::Invalid(_) => "invalid",
            AppError::Conflict(_) => "conflict",
            AppError::Db(_) => "database",
            AppError::Json(_) => "json",
            AppError::Io(_) => "io",
        }
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        AppError::Invalid(msg.into())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        // Constraint failures are caused by bad input (unknown project id, duplicate name...),
        // so report them as such instead of as an internal database error.
        if let rusqlite::Error::SqliteFailure(f, msg) = &e
            && f.code == rusqlite::ErrorCode::ConstraintViolation
        {
            let detail = msg.clone().unwrap_or_else(|| "constraint failed".into());
            if detail.contains("UNIQUE") {
                return AppError::Conflict(detail);
            }
            return AppError::Invalid(detail);
        }
        if let rusqlite::Error::QueryReturnedNoRows = e {
            return AppError::NotFound("record".into());
        }
        AppError::Db(e)
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}
