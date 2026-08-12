//! `devpipe` — the vault, from inside a box.
//!
//! Two faces on one binary. A person types `devpipe value get NAME`; an agent
//! speaks MCP to `devpipe mcp` over stdio. Both go through the same client, so
//! there is one place where the rules live and no chance of the two drifting.
//!
//! Compiled rather than scripted because the box should need no runtime: it
//! already downloads one static `devpiped`, and this rides the same path. An
//! MCP server is also spawned per session, so start-up time is a cost paid
//! constantly — a script that has to boot an interpreter first is the wrong
//! shape for it.
//!
//! **What this can and cannot do is decided by the server, not here.** The
//! credential in `DEVPIPE_VAULT_TOKEN` reaches one box's own scope chain, reads
//! values freely, and reads a *secret* only where the owner granted this box
//! that entry. Nothing in this file can widen that, which is the point: an
//! agent that rewrites its own tooling still cannot reach further than the
//! token allows.

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

const USAGE: &str = "\
devpipe — your vault, from inside this box

  devpipe value list                 names and kinds this box may use
  devpipe value get <name>           read a value (or a granted secret)
  devpipe value set <name> <value>   write a value into this box's scope
  devpipe mcp                        serve the vault to an agent over MCP

Reads DEVPIPE_VAULT_URL and DEVPIPE_VAULT_TOKEN, which cloud-init installs at
/etc/devpipe/vault.env and exports to login shells.
";

/// Where the vault is, and what this box authenticates with.
struct Client {
    url: String,
    token: String,
}

impl Client {
    /// From the environment, or an explanation of what is missing.
    ///
    /// A box provisioned before the vault existed simply has neither, and the
    /// message says so rather than failing as an opaque network error later.
    fn from_env() -> Result<Client, String> {
        let url = std::env::var("DEVPIPE_VAULT_URL").unwrap_or_default();
        let token = std::env::var("DEVPIPE_VAULT_TOKEN").unwrap_or_default();
        if url.is_empty() || token.is_empty() {
            return Err(
                "This box has no vault credential. DEVPIPE_VAULT_URL and DEVPIPE_VAULT_TOKEN are \
                 set from /etc/devpipe/vault.env; a box created before the vault existed will not \
                 have one until it is rebuilt."
                    .to_string(),
            );
        }
        Ok(Client { url, token })
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        self.send(ureq::get(&format!("{}{path}", self.url)))
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.send_with(ureq::post(&format!("{}{path}", self.url)), Some(body))
    }

    fn send(&self, req: ureq::Request) -> Result<Value, String> {
        self.send_with(req, None)
    }

    /// One request, with the server's own error text surfaced verbatim.
    ///
    /// A refusal here is usually a *policy* answer — "that is a secret, and
    /// this box has not been granted it" — and rewriting it into something
    /// generic would hide the one sentence that tells the reader what to do.
    fn send_with(&self, req: ureq::Request, body: Option<Value>) -> Result<Value, String> {
        let req = req.set("authorization", &format!("Bearer {}", self.token));
        let result = match body {
            Some(value) => req.send_json(value),
            None => req.call(),
        };
        match result {
            Ok(response) => response.into_json::<Value>().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, response)) => {
                let detail = response
                    .into_json::<Value>()
                    .ok()
                    .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| format!("the vault answered {code}"));
                Err(detail)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn list(&self) -> Result<Value, String> {
        self.get("")
    }

    fn read(&self, name: &str) -> Result<Value, String> {
        self.get(&format!("/{name}"))
    }

    fn write(&self, name: &str, value: &str) -> Result<Value, String> {
        self.post(&format!("/{name}"), json!({ "value": value }))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let code = match words.as_slice() {
        [] | ["-h"] | ["--help"] | ["help"] => {
            print!("{USAGE}");
            0
        }
        ["mcp"] => serve_mcp(),
        ["value", rest @ ..] => value_command(rest),
        other => {
            eprintln!("devpipe: unknown command `{}`\n", other.join(" "));
            eprint!("{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

fn value_command(args: &[&str]) -> i32 {
    let client = match Client::from_env() {
        Ok(client) => client,
        Err(why) => {
            eprintln!("devpipe: {why}");
            return 1;
        }
    };
    match args {
        ["list"] => match client.list() {
            Ok(items) => {
                // Aligned, and honest about what is readable: a name an agent
                // cannot read is worth showing, because "it exists but you were
                // not granted it" is a different problem from "it is not there".
                for item in items.as_array().cloned().unwrap_or_default() {
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                    let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
                    let readable = item.get("readable").and_then(Value::as_bool).unwrap_or(false);
                    let scope = item.get("scope").and_then(Value::as_str).unwrap_or("");
                    let note = if readable { "" } else { "  (not granted to this box)" };
                    println!("{name:<28} {kind:<7} {scope:<10}{note}");
                }
                0
            }
            Err(why) => {
                eprintln!("devpipe: {why}");
                1
            }
        },
        ["get", name] => match client.read(name) {
            // The bare value, no label: this is meant to be substituted into a
            // command or captured into a variable.
            Ok(entry) => {
                println!("{}", entry.get("value").and_then(Value::as_str).unwrap_or(""));
                0
            }
            Err(why) => {
                eprintln!("devpipe: {why}");
                1
            }
        },
        ["set", name, value] => match client.write(name, value) {
            Ok(_) => 0,
            Err(why) => {
                eprintln!("devpipe: {why}");
                1
            }
        },
        _ => {
            eprint!("{USAGE}");
            2
        }
    }
}

// ── MCP ─────────────────────────────────────────────────────────────────────

/// The tools an agent sees. Deliberately three: the vault is a small idea, and
/// a wide surface here would be a wide surface to get wrong.
fn tool_list() -> Value {
    json!({
        "tools": [
            {
                "name": "vault_list",
                "description": "List the vault entries this box may use. Returns each name, \
                                whether it is a value or a secret, and whether this box is \
                                allowed to read it. Never returns any values.",
                "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
            },
            {
                "name": "vault_get",
                "description": "Read one vault entry by name. Values are always readable. A \
                                secret is readable only if its owner granted this box that \
                                entry; otherwise this returns a refusal, which is not an error \
                                to work around.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "name": { "type": "string" } },
                    "required": ["name"],
                    "additionalProperties": false
                }
            },
            {
                "name": "vault_set",
                "description": "Write a value into this box's own scope. Cannot create or \
                                overwrite a secret.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "name": { "type": "string" }, "value": { "type": "string" } },
                    "required": ["name", "value"],
                    "additionalProperties": false
                }
            }
        ]
    })
}

/// One MCP tool call, as content the agent reads.
fn call_tool(client: &Client, name: &str, args: &Value) -> Value {
    let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let outcome = match name {
        "vault_list" => client.list(),
        "vault_get" => client.read(&arg("name")),
        "vault_set" => client.write(&arg("name"), &arg("value")),
        other => Err(format!("no such tool: {other}")),
    };
    match outcome {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": value.to_string() }]
        }),
        // `isError` rather than a JSON-RPC error: a refusal is a *result* the
        // agent should read and respect, not a transport failure to retry.
        Err(why) => json!({
            "content": [{ "type": "text", "text": why }],
            "isError": true
        }),
    }
}

/// A minimal MCP server over stdio: one JSON-RPC message per line.
fn serve_mcp() -> i32 {
    let client = match Client::from_env() {
        Ok(client) => client,
        Err(why) => {
            eprintln!("devpipe: {why}");
            return 1;
        }
    };
    let stdin = io::stdin();
    let mut out = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(json!({}));

        let result = match method {
            "initialize" => Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "devpipe", "version": env!("CARGO_PKG_VERSION") }
            })),
            "tools/list" => Some(tool_list()),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                Some(call_tool(&client, name, &args))
            }
            // Notifications carry no id and expect no reply; answering one is a
            // protocol error rather than a courtesy.
            _ => None,
        };

        let Some(result) = result else { continue };
        let Some(id) = id else { continue };
        let response = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        if writeln!(out, "{response}").is_err() || out.flush().is_err() {
            break;
        }
    }
    0
}
