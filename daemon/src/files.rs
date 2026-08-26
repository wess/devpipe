//! Files on the box, reachable from the machine you are sitting at.
//!
//! The gap this closes is embarrassingly basic: there was no way to move a file
//! between a box and a laptop in either direction. Not a spec you want an agent
//! to read, not a screenshot it produced, not the one file you would rather fix
//! in your own editor. The workarounds were a git round-trip for things that are
//! not code, or pasting into a heredoc down a terminal.
//!
//! It rides the door that already exists — Caddy in front, the daemon's bearer
//! behind — rather than opening SSH back up. SSH is deliberately locked down on
//! a box (`DisableForwarding yes`), its host key changes on every wake because
//! waking builds a new machine, and neither of those is worth undoing for file
//! transfer.
//!
//! **No jail, and that is considered.** The bearer that reaches here is the same
//! one that spawns a process on `/v1/sessions` — a shell as the box user, who
//! holds passwordless sudo by design, so root is one word away. A path
//! restriction would stop nothing an attacker could not do in one more request,
//! while breaking the legitimate case of reading a config outside the home
//! directory. The credential is the boundary. What this does refuse is the
//! accident: writing to a path that is not absolute.
//!
//! Directories come *down* as a tar and go *up* one file at a time, which looks
//! asymmetric and is deliberate. Producing an archive is safe by construction;
//! consuming one is not — the names inside are chosen by whoever made it, and
//! `../../etc/cron.d/x` is the oldest trick there is. Extracting an untrusted
//! archive as root, to save a few round trips on the rarer direction, is not a
//! trade worth making.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, extract::Request};
use serde::{Deserialize, Serialize};

use crate::{App, TokenQuery, authorized};

#[derive(Deserialize)]
pub struct PathQuery {
    path: String,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
    size: u64,
    /// Seconds since the epoch, or 0 when the filesystem will not say.
    modified: u64,
    /// A symlink is reported as what it is rather than as what it points at:
    /// a tree walk that silently follows one can descend forever.
    link: bool,
}

#[derive(Serialize)]
pub struct Listing {
    path: String,
    entries: Vec<Entry>,
}

/// `~` and `~/x`, since the caller is a person typing a path.
///
/// Only a leading tilde, and only the daemon's own home — a box has one user
/// that matters and `~otheruser` is a lookup this has no business doing.
fn expand(path: &str) -> PathBuf {
    if path == "~" {
        return home();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home().join(rest);
    }
    PathBuf::from(path)
}

fn home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/root"))
}

fn seconds(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn refuse(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, format!("{message}\n")).into_response()
}

/// Errors as the person reading them would want them.
///
/// `std::io::Error`'s own text is "No such file or directory (os error 2)",
/// which says nothing about *which* file — and the path is the entire question
/// when the caller typed it.
fn failed(path: &Path, err: std::io::Error) -> Response {
    let status = match err.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    refuse(status, format!("{}: {err}", path.display()))
}

pub async fn list(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Response {
    if !authorized(
        &app,
        &headers,
        &TokenQuery {
            token: q.token.clone(),
        },
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let path = expand(&q.path);
    let read = match std::fs::read_dir(&path) {
        Ok(r) => r,
        Err(e) => return failed(&path, e),
    };

    let mut entries: Vec<Entry> = Vec::new();
    for item in read.flatten() {
        // `symlink_metadata`, not `metadata`: a broken link is still an entry
        // worth listing, and following one turns a listing into a traversal.
        let Ok(meta) = std::fs::symlink_metadata(item.path()) else {
            continue;
        };
        entries.push(Entry {
            name: item.file_name().to_string_lossy().to_string(),
            dir: meta.is_dir(),
            size: meta.len(),
            modified: seconds(&meta),
            link: meta.file_type().is_symlink(),
        });
    }
    // Directories first, then by name, because that is how every file list a
    // person has ever read is ordered.
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));

    Json(Listing {
        path: path.to_string_lossy().to_string(),
        entries,
    })
    .into_response()
}

pub async fn read(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Response {
    if !authorized(
        &app,
        &headers,
        &TokenQuery {
            token: q.token.clone(),
        },
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let path = expand(&q.path);
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return failed(&path, e),
    };
    if meta.is_dir() {
        return refuse(
            StatusCode::BAD_REQUEST,
            format!("{} is a directory", path.display()),
        );
    }

    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => return failed(&path, e),
    };
    // Streamed rather than read into memory: a box has 512MB and the thing
    // somebody wants back is as likely to be a build artifact as a source file.
    let stream = tokio_util::io::ReaderStream::new(file);
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, meta.len().to_string()),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

pub async fn write(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
    req: Request,
) -> Response {
    if !authorized(
        &app,
        &headers,
        &TokenQuery {
            token: q.token.clone(),
        },
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let path = expand(&q.path);
    if !path.is_absolute() {
        return refuse(
            StatusCode::BAD_REQUEST,
            "give a path from the root, or one starting with ~",
        );
    }
    if let Some(parent) = path.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        return failed(parent, e);
    }

    // Written beside the target and renamed over it. A half-written file that
    // still has its old name is the failure that costs somebody a morning:
    // an editor opens it, the agent reads it, and nothing says it is a torso.
    let temp = path.with_extension(format!(
        "{}.dp-partial",
        path.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    let mut file = match tokio::fs::File::create(&temp).await {
        Ok(f) => f,
        Err(e) => return failed(&temp, e),
    };

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut body = req.into_body().into_data_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = body.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = tokio::fs::remove_file(&temp).await;
                return refuse(
                    StatusCode::BAD_REQUEST,
                    format!("the upload stopped early: {e}"),
                );
            }
        };
        if let Err(e) = file.write_all(&bytes).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return failed(&path, e);
        }
        written += bytes.len() as u64;
    }
    if let Err(e) = file.sync_all().await {
        let _ = tokio::fs::remove_file(&temp).await;
        return failed(&path, e);
    }
    drop(file);
    if let Err(e) = tokio::fs::rename(&temp, &path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return failed(&path, e);
    }

    Json(serde_json::json!({ "path": path.to_string_lossy(), "bytes": written })).into_response()
}

/// A directory, as one stream.
///
/// The alternative is the client walking the tree and asking for each file,
/// which is correct and is a request per file — fine for a folder, miserable
/// for a project. `tar` is on every box this runs on.
pub async fn tar(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Response {
    if !authorized(
        &app,
        &headers,
        &TokenQuery {
            token: q.token.clone(),
        },
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let path = expand(&q.path);
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return failed(&path, e),
    };
    if !meta.is_dir() {
        return refuse(
            StatusCode::BAD_REQUEST,
            format!("{} is not a directory", path.display()),
        );
    }
    // `-C parent name` rather than an absolute path, so the archive holds
    // relative names and unpacks into whatever directory the caller chose.
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return refuse(
            StatusCode::BAD_REQUEST,
            "that directory has no name to archive",
        );
    };

    let spawned = tokio::process::Command::new("tar")
        .arg("-czf")
        .arg("-")
        .arg("-C")
        .arg(parent)
        .arg(name)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return refuse(StatusCode::INTERNAL_SERVER_ERROR, format!("tar: {e}")),
    };
    let Some(stdout) = child.stdout.take() else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "tar produced nothing");
    };
    // Reaped in the background. Without this it stays a zombie for the life of
    // the daemon, and a box that has served a hundred directories has a hundred.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    (
        [
            (header::CONTENT_TYPE, "application/gzip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}.tar.gz\"", name.to_string_lossy()),
            ),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(stdout)),
    )
        .into_response()
}

pub async fn mkdir(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Response {
    if !authorized(
        &app,
        &headers,
        &TokenQuery {
            token: q.token.clone(),
        },
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let path = expand(&q.path);
    match std::fs::create_dir_all(&path) {
        Ok(()) => Json(serde_json::json!({ "path": path.to_string_lossy() })).into_response(),
        Err(e) => failed(&path, e),
    }
}

pub async fn remove(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Response {
    if !authorized(
        &app,
        &headers,
        &TokenQuery {
            token: q.token.clone(),
        },
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let path = expand(&q.path);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) => return failed(&path, e),
    };
    // Recursive for a directory, because the alternative is a client that has
    // to walk a tree bottom-up over the network to delete a folder.
    let done = if meta.is_dir() && !meta.file_type().is_symlink() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    };
    match done {
        Ok(()) => Json(serde_json::json!({ "path": path.to_string_lossy() })).into_response(),
        Err(e) => failed(&path, e),
    }
}

#[cfg(test)]
mod tests {
    use super::expand;
    use std::path::Path;

    #[test]
    fn a_tilde_means_the_box_user() {
        // The caller is a person typing a path, and `~/project` is what they
        // type. Nothing else expands: `~someoneelse` is a lookup this does not
        // do, so it stays a literal and fails as a missing directory.
        unsafe { std::env::set_var("HOME", "/home/devpipe") };
        assert_eq!(expand("~"), Path::new("/home/devpipe"));
        assert_eq!(
            expand("~/src/main.rs"),
            Path::new("/home/devpipe/src/main.rs")
        );
        assert_eq!(expand("/etc/hosts"), Path::new("/etc/hosts"));
        assert_eq!(expand("~other/x"), Path::new("~other/x"));
    }
}
