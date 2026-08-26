//! Moving a file between a box and the machine you are sitting at.
//!
//! There was no way to do this at all, in either direction — not a spec for an
//! agent to read, not an artifact it produced. These run against real sockets
//! and a real temporary directory, because every interesting failure here is
//! about what actually landed on disk.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "test-token";

async fn daemon() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(devpiped::serve(listener, TOKEN.to_string()));
    port
}

/// A directory of this test's own, named for the test so a failure leaves
/// something identifiable behind.
fn workdir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("devpiped-fs-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One request, headers and body, without a client crate.
async fn call(port: u16, head: &str, body: &[u8]) -> (String, Vec<u8>) {
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    socket.write_all(head.as_bytes()).await.unwrap();
    if !body.is_empty() {
        socket.write_all(body).await.unwrap();
    }
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).await.unwrap();
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = raw.get(split + 4..).unwrap_or(&[]).to_vec();
    // A response with no length is chunked, which is correct of the server and
    // has to be undone here — a streamed directory has no length to send.
    let body = if head.to_lowercase().contains("transfer-encoding: chunked") {
        dechunk(&body)
    } else {
        body
    };
    (head, body)
}

fn dechunk(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0usize;
    loop {
        let Some(eol) = raw[at..].windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size = usize::from_str_radix(
            String::from_utf8_lossy(&raw[at..at + eol])
                .split(';')
                .next()
                .unwrap_or("0")
                .trim(),
            16,
        )
        .unwrap_or(0);
        at += eol + 2;
        if size == 0 || at + size > raw.len() {
            break;
        }
        out.extend_from_slice(&raw[at..at + size]);
        at += size + 2;
    }
    out
}

async fn get(port: u16, path: &str) -> (String, Vec<u8>) {
    call(
        port,
        &format!(
            "GET {path} HTTP/1.1\r\nHost: box\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n"
        ),
        b"",
    )
    .await
}

fn q(path: &std::path::Path) -> String {
    // Enough escaping for the paths these tests use.
    path.to_string_lossy().replace(' ', "%20")
}

#[tokio::test]
async fn a_file_comes_back_byte_for_byte() {
    let dir = workdir("read");
    std::fs::write(dir.join("notes.md"), "# hello\n\u{1F600}\n").unwrap();
    let port = daemon().await;

    let (head, body) = get(
        port,
        &format!("/v1/fs/read?path={}", q(&dir.join("notes.md"))),
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(String::from_utf8_lossy(&body), "# hello\n\u{1F600}\n");
}

#[tokio::test]
async fn a_listing_puts_directories_first_and_names_symlinks() {
    let dir = workdir("list");
    std::fs::create_dir(dir.join("src")).unwrap();
    std::fs::write(dir.join("a.txt"), "a").unwrap();
    std::fs::write(dir.join("b.txt"), "bb").unwrap();
    // Following one of these turns a listing into a traversal, so it is
    // reported as what it is rather than as what it points at.
    std::os::unix::fs::symlink("/etc/passwd", dir.join("z-link")).unwrap();
    let port = daemon().await;

    let (head, body) = get(port, &format!("/v1/fs/list?path={}", q(&dir))).await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let seen: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let entries = seen["entries"].as_array().unwrap();
    assert_eq!(entries[0]["name"], "src");
    assert_eq!(entries[0]["dir"], true);
    assert_eq!(entries[1]["name"], "a.txt");
    assert_eq!(entries[2]["size"], 2);
    let link = entries.iter().find(|e| e["name"] == "z-link").unwrap();
    assert_eq!(link["link"], true);
    assert_eq!(
        link["dir"], false,
        "a symlink to a file must not be reported as its target"
    );
}

#[tokio::test]
async fn a_written_file_is_never_half_a_file() {
    // Written beside the target and renamed over it. The failure this prevents
    // is an editor — or an agent — reading a torso that still has the right
    // name and nothing saying it is incomplete.
    let dir = workdir("write");
    let target = dir.join("deep/nested/config.toml");
    let port = daemon().await;

    let payload = b"key = \"value\"\n";
    let (head, _) = call(
        port,
        &format!(
            "PUT /v1/fs/write?path={} HTTP/1.1\r\nHost: box\r\nAuthorization: Bearer {TOKEN}\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n",
            q(&target),
            payload.len()
        ),
        payload,
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    // The parents were made on the way, because the alternative is a client
    // that has to mkdir each level before it can send anything.
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "key = \"value\"\n"
    );
    // Nothing left behind.
    let strays: Vec<_> = std::fs::read_dir(target.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains("dp-partial"))
        .collect();
    assert!(strays.is_empty(), "a partial file was left on disk");
}

#[tokio::test]
async fn a_directory_comes_back_as_one_archive() {
    let dir = workdir("tar");
    std::fs::create_dir_all(dir.join("project/src")).unwrap();
    std::fs::write(dir.join("project/src/main.rs"), "fn main() {}\n").unwrap();
    let port = daemon().await;

    let (head, body) = get(
        port,
        &format!("/v1/fs/tar?path={}", q(&dir.join("project"))),
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(head.contains("project.tar.gz"), "{head}");
    // Gzip's magic, so this is an archive rather than an error page with a
    // 200 on it.
    assert_eq!(&body[..2], &[0x1f, 0x8b], "that is not a gzip stream");

    // And it unpacks to relative names, so it lands wherever it is put rather
    // than trying to restore an absolute path.
    let out = workdir("tar-out");
    let mut child = std::process::Command::new("tar")
        .arg("-xzf")
        .arg("-")
        .arg("-C")
        .arg(&out)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), &body).unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(
        std::fs::read_to_string(out.join("project/src/main.rs")).unwrap(),
        "fn main() {}\n"
    );
}

#[tokio::test]
async fn removing_a_directory_takes_what_is_in_it() {
    let dir = workdir("remove");
    std::fs::create_dir_all(dir.join("gone/deeper")).unwrap();
    std::fs::write(dir.join("gone/deeper/x"), "x").unwrap();
    let port = daemon().await;

    let (head, _) = call(
        port,
        &format!(
            "DELETE /v1/fs/remove?path={} HTTP/1.1\r\nHost: box\r\nAuthorization: Bearer {TOKEN}\r\n\
             Connection: close\r\n\r\n",
            q(&dir.join("gone"))
        ),
        b"",
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(!dir.join("gone").exists());
}

#[tokio::test]
async fn a_missing_file_says_which_file() {
    // `std::io::Error` alone reads "No such file or directory (os error 2)",
    // and the path is the entire question when the caller typed it.
    let dir = workdir("missing");
    let port = daemon().await;
    let (head, body) = get(
        port,
        &format!("/v1/fs/read?path={}", q(&dir.join("nope.txt"))),
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 404"), "{head}");
    assert!(
        String::from_utf8_lossy(&body).contains("nope.txt"),
        "{:?}",
        String::from_utf8_lossy(&body)
    );
}

#[tokio::test]
async fn a_directory_is_not_a_file() {
    let dir = workdir("isdir");
    let port = daemon().await;
    let (head, _) = get(port, &format!("/v1/fs/read?path={}", q(&dir))).await;
    assert!(head.starts_with("HTTP/1.1 400"), "{head}");
}

#[tokio::test]
async fn every_one_of_them_needs_the_token() {
    // Same bearer as everything else on the daemon. Without it this is an
    // unauthenticated read of any file on somebody's machine.
    let dir = workdir("auth");
    std::fs::write(dir.join("secret"), "s").unwrap();
    let port = daemon().await;

    for path in [
        format!("/v1/fs/list?path={}", q(&dir)),
        format!("/v1/fs/read?path={}", q(&dir.join("secret"))),
        format!("/v1/fs/tar?path={}", q(&dir)),
    ] {
        let (head, _) = call(
            port,
            &format!("GET {path} HTTP/1.1\r\nHost: box\r\nConnection: close\r\n\r\n"),
            b"",
        )
        .await;
        assert!(
            head.starts_with("HTTP/1.1 401"),
            "{path} answered without a token: {head}"
        );
    }
}
