//! End-to-end checks against a real sshd. Skipped unless these are set:
//!
//!   TERN_TEST_SSH_PORT  port of an sshd on 127.0.0.1 that accepts the current user
//!   TERN_TEST_KEY_DIR   directory holding `client_plain` (no passphrase) and
//!                       `client_pass` (passphrase "hunter2"), both authorized
//!
//! The server runs on this machine, so "remote" paths are local paths too.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Listener, Manager};

use crate::db::{Db, HostInput};
use crate::sftp::{self, TransferRequest};
use crate::ssh::{PromptReply, SessionEvent};
use crate::state::AppState;
use crate::terminal::{self, OpenArgs, TerminalCmd};

struct Env {
    port: u16,
    keys: PathBuf,
}

fn env() -> Option<Env> {
    Some(Env {
        port: std::env::var("TERN_TEST_SSH_PORT").ok()?.parse().ok()?,
        keys: std::env::var("TERN_TEST_KEY_DIR").ok()?.into(),
    })
}

/// Records every session event and answers prompts from a script.
#[derive(Clone, Default)]
struct Script {
    seen: Arc<Mutex<Vec<serde_json::Value>>>,
    answers: Arc<Mutex<VecDeque<PromptReply>>>,
}

impl Script {
    fn channel(&self, app: &tauri::AppHandle<tauri::test::MockRuntime>) -> Channel<SessionEvent> {
        let (seen, answers, prompts) = (
            self.seen.clone(),
            self.answers.clone(),
            app.state::<AppState>().prompts.clone(),
        );
        Channel::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                return Ok(());
            };
            let ev: serde_json::Value = serde_json::from_str(&json).unwrap();
            if let Some(id) = ev.get("requestId").and_then(|v| v.as_u64()) {
                let reply = answers.lock().unwrap().pop_front().unwrap_or(PromptReply {
                    accept: false,
                    answers: vec![],
                    save: false,
                });
                prompts.answer(id, reply);
            }
            seen.lock().unwrap().push(ev);
            Ok(())
        })
    }

    fn count(&self, kind: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == kind)
            .count()
    }

    fn push(&self, accept: bool, answers: &[&str]) {
        self.answers.lock().unwrap().push_back(PromptReply {
            accept,
            answers: answers.iter().map(|s| s.to_string()).collect(),
            save: false,
        });
    }
}

fn host_input(env: &Env, key: &str) -> HostInput {
    HostInput {
        id: None,
        name: format!("test-{key}"),
        address: "127.0.0.1".into(),
        port: env.port,
        username: whoami(),
        group_name: Some("Test".into()),
        auth: "key".into(),
        key_path: Some(env.keys.join(key).display().to_string()),
        tags: vec![],
        key_id: None,
    }
}

fn whoami() -> String {
    std::env::var("USER").unwrap_or_else(|_| "root".into())
}

async fn wait_for(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn ssh_terminal_and_sftp_end_to_end() {
    let Some(env) = env() else {
        eprintln!("skipped: TERN_TEST_SSH_PORT / TERN_TEST_KEY_DIR not set");
        return;
    };
    let tmp = std::env::temp_dir().join(format!("tern-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AppState {
        db: Db::open(&tmp.join("tern.db")).unwrap(),
        prompts: Default::default(),
        known_hosts_path: tmp.join("known_hosts"),
        terminals: Default::default(),
        connections: Default::default(),
        sftp: Default::default(),
        transfers: Default::default(),
    });
    let app = app.handle().clone();
    let state = app.state::<AppState>();

    tauri::async_runtime::block_on(async {
        // 1. First connect: unknown host key is prompted for, accepted and saved.
        let id = state
            .db
            .save_host(&host_input(&env, "client_plain"))
            .unwrap();
        let host = state.db.get_host(&id).unwrap();
        let script = Script::default();
        script.push(true, &[]);
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let out = output.clone();
        let data = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(b) = body {
                out.lock().unwrap().extend(b);
            }
            Ok(())
        });
        let info = terminal::open(
            app.clone(),
            "s1".into(),
            OpenArgs {
                host: host.clone(),
                cols: 100,
                rows: 30,
                data,
                events: script.channel(&app),
            },
        )
        .await
        .expect("terminal connects");
        assert_eq!(
            script.count("hostKey"),
            1,
            "first connection asks about the host key"
        );
        assert!(
            info.auth_label.contains("client_plain"),
            "auth label: {}",
            info.auth_label
        );
        assert!(info.fingerprint.starts_with("SHA256:"));
        let known = std::fs::read_to_string(tmp.join("known_hosts")).unwrap();
        assert!(
            known.contains(&format!("[127.0.0.1]:{}", env.port)),
            "known_hosts: {known}"
        );

        // 2. The shell runs commands and reports the PTY size we asked for.
        // Login shells can print prompts of their own (e.g. oh-my-zsh update checks) that eat
        // early keystrokes, so keep sending until the command's output shows up.
        let seen = |needle: &str| String::from_utf8_lossy(&output.lock().unwrap()).contains(needle);
        for _ in 0..10 {
            terminal::send(
                &app,
                "s1",
                TerminalCmd::Input(b"echo tern-ok-$((6*7)); stty size\n".to_vec()),
            );
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if seen("tern-ok-42") {
                break;
            }
        }
        assert!(seen("tern-ok-42"), "shell never ran the command");
        wait_for("stty size", || {
            String::from_utf8_lossy(&output.lock().unwrap()).contains("30 100")
        })
        .await;
        terminal::send(&app, "s1", TerminalCmd::Resize(120, 40));
        terminal::send(&app, "s1", TerminalCmd::Input(b"stty size\n".to_vec()));
        wait_for("resized", || {
            String::from_utf8_lossy(&output.lock().unwrap()).contains("40 120")
        })
        .await;

        // OS detection runs in the background after connect.
        wait_for("os detection", || {
            state.db.get_host(&id).unwrap().os_id.is_some()
        })
        .await;
        assert_eq!(
            state.db.get_host(&id).unwrap().os_id.as_deref(),
            Some("macos")
        );

        // 3. `exit` ends the session and it deregisters itself.
        terminal::send(&app, "s1", TerminalCmd::Input(b"exit\n".to_vec()));
        wait_for("session exit", || script.count("exit") == 1).await;
        wait_for("deregistered", || {
            state.terminals.lock().unwrap().is_empty()
        })
        .await;
        assert_eq!(state.db.host_history(&id, 5).unwrap().len(), 1);
        assert!(state.db.host_history(&id, 5).unwrap()[0].ended_at.is_some());

        // 4. Encrypted key: a wrong passphrase is retried, the right one works, and the known host isn't re-prompted.
        let id2 = state
            .db
            .save_host(&host_input(&env, "client_pass"))
            .unwrap();
        let script2 = Script::default();
        script2.push(true, &["wrong"]);
        script2.push(true, &["hunter2"]);
        let conn = crate::ssh::connect(
            &app,
            &state.db.get_host(&id2).unwrap(),
            &script2.channel(&app),
        )
        .await
        .expect("passphrase key connects");
        assert_eq!(script2.count("hostKey"), 0, "host key is remembered");
        assert_eq!(script2.count("prompt"), 2, "asked twice for the passphrase");
        drop(conn);

        // 5. A cancelled passphrase prompt fails cleanly instead of hanging.
        let script3 = Script::default();
        script3.push(false, &[]);
        let err = crate::ssh::connect(
            &app,
            &state.db.get_host(&id2).unwrap(),
            &script3.channel(&app),
        )
        .await
        .err()
        .expect("cancelled auth fails");
        assert!(err.to_string().contains("Permission denied"), "{err}");

        // 6. A changed host key is flagged and, once accepted, replaces the old entry.
        let fake = std::fs::read_to_string(env.keys.join("client_plain.pub")).unwrap();
        let fake_key = fake
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        std::fs::write(
            tmp.join("known_hosts"),
            format!("[127.0.0.1]:{} {fake_key}\n", env.port),
        )
        .unwrap();
        let script4 = Script::default();
        script4.push(true, &[]);
        crate::ssh::connect(&app, &host, &script4.channel(&app))
            .await
            .expect("replaced key connects");
        let ev = script4
            .seen
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "hostKey")
            .cloned()
            .unwrap();
        assert_eq!(ev["status"], "changed");
        assert_eq!(ev["canReplace"], true);
        assert!(!std::fs::read_to_string(tmp.join("known_hosts"))
            .unwrap()
            .contains(&fake_key));

        // 7. Rejecting a changed key refuses the connection.
        std::fs::write(
            tmp.join("known_hosts"),
            format!("[127.0.0.1]:{} {fake_key}\n", env.port),
        )
        .unwrap();
        let script5 = Script::default();
        script5.push(false, &[]);
        let err = crate::ssh::connect(&app, &host, &script5.channel(&app))
            .await
            .err()
            .expect("rejected");
        assert!(err.to_string().contains("not trusted"), "{err}");
        std::fs::remove_file(tmp.join("known_hosts")).unwrap();

        // 8. SFTP: list, upload a directory, download it back, rename, delete.
        let script6 = Script::default();
        script6.push(true, &[]);
        let sftp_info = sftp::open(&app, host.clone(), "f1".into(), script6.channel(&app))
            .await
            .expect("sftp opens");
        assert!(!sftp_info.home.is_empty());

        let local = tmp.join("local/payload");
        std::fs::create_dir_all(local.join("nested")).unwrap();
        let blob: Vec<u8> = (0..3_000_000u32).map(|i| (i * 7 % 251) as u8).collect();
        std::fs::write(local.join("big.bin"), &blob).unwrap();
        std::fs::write(local.join("nested/note.txt"), b"hello").unwrap();
        let remote_dir = tmp.join("remote");
        std::fs::create_dir_all(&remote_dir).unwrap();
        let remote_dir = remote_dir.display().to_string();

        let finished: Arc<Mutex<Vec<serde_json::Value>>> = Default::default();
        let f = finished.clone();
        app.listen_any("transfer", move |e| {
            let v: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
            if v["state"] != "running" {
                f.lock().unwrap().push(v);
            }
        });

        sftp::start_transfer(
            app.clone(),
            TransferRequest {
                id: "t1".into(),
                sftp_id: "f1".into(),
                direction: "upload".into(),
                source: local.display().to_string(),
                dest_dir: remote_dir.clone(),
            },
        )
        .unwrap();
        wait_for("upload", || !finished.lock().unwrap().is_empty()).await;
        let up = finished.lock().unwrap()[0].clone();
        assert_eq!(up["state"], "done", "{up}");
        assert_eq!(up["total"], 3_000_005);
        assert_eq!(
            std::fs::read(format!("{remote_dir}/payload/big.bin")).unwrap(),
            blob
        );

        let listing = sftp::list(&app, "f1", &format!("{remote_dir}/payload"))
            .await
            .unwrap();
        let names: Vec<_> = listing
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir))
            .collect();
        assert_eq!(names, vec![("nested", true), ("big.bin", false)]);

        let down = tmp.join("down");
        std::fs::create_dir_all(&down).unwrap();
        sftp::start_transfer(
            app.clone(),
            TransferRequest {
                id: "t2".into(),
                sftp_id: "f1".into(),
                direction: "download".into(),
                source: format!("{remote_dir}/payload"),
                dest_dir: down.display().to_string(),
            },
        )
        .unwrap();
        wait_for("download", || finished.lock().unwrap().len() == 2).await;
        assert_eq!(finished.lock().unwrap()[1]["state"], "done");
        assert_eq!(std::fs::read(down.join("payload/big.bin")).unwrap(), blob);
        assert_eq!(
            std::fs::read(down.join("payload/nested/note.txt")).unwrap(),
            b"hello"
        );

        sftp::rename(
            &app,
            "f1",
            &format!("{remote_dir}/payload"),
            &format!("{remote_dir}/renamed"),
        )
        .await
        .unwrap();
        sftp::remove(&app, "f1", &format!("{remote_dir}/renamed"), true)
            .await
            .unwrap();
        assert!(
            std::fs::read_dir(&remote_dir).unwrap().next().is_none(),
            "remote dir is empty after delete"
        );
        sftp::close(&app, "f1").await;

        // 10. Keychain: import (with passphrase rules), dedupe, generate, connect, delete.
        crate::vault::use_ephemeral_key();
        let path = |k: &str| Some(env.keys.join(k).display().to_string());
        let plain = crate::keychain::import(&state.db, "", None, path("client_plain"), None)
            .expect("import plain");
        assert_eq!(
            plain.name, "tern-test-plain",
            "unnamed keys take the file's comment"
        );
        assert_eq!(plain.algorithm, "ED25519");
        assert!(plain.public_key.starts_with("ssh-ed25519 "));
        assert!(!plain.encrypted);

        let dup = crate::keychain::import(&state.db, "again", None, path("client_plain"), None)
            .unwrap_err();
        assert!(dup.to_string().contains("already in the keychain"), "{dup}");

        let pem = std::fs::read_to_string(env.keys.join("client_pass")).unwrap();
        let no_pass =
            crate::keychain::import(&state.db, "Prod", Some(pem.clone()), None, None).unwrap_err();
        assert!(no_pass.to_string().contains("passphrase"), "{no_pass}");
        let wrong = crate::keychain::import(
            &state.db,
            "Prod",
            Some(pem.clone()),
            None,
            Some("nope".into()),
        )
        .unwrap_err();
        assert!(wrong.to_string().contains("doesn't unlock"), "{wrong}");
        let protected =
            crate::keychain::import(&state.db, "Prod", Some(pem), None, Some("hunter2".into()))
                .expect("import pass");
        assert!(protected.encrypted);

        let public = std::fs::read_to_string(env.keys.join("client_plain.pub")).unwrap();
        let pubkey = crate::keychain::import(&state.db, "", Some(public), None, None).unwrap_err();
        assert!(pubkey.to_string().contains("public key"), "{pubkey}");

        let generated = crate::keychain::generate(&state.db, "laptop").expect("generate");
        assert!(
            generated.public_key.starts_with("ssh-ed25519 ")
                && generated.public_key.ends_with(" laptop")
        );
        let (reloaded, _) = crate::keychain::load(&state.db, &generated.id).unwrap();
        assert_eq!(
            reloaded
                .public_key()
                .fingerprint(russh::keys::HashAlg::Sha256)
                .to_string(),
            generated.fingerprint
        );

        // Hosts using saved keys connect with no prompts, including the passphrase-protected one.
        for key in [&plain, &protected] {
            let mut input = host_input(&env, "unused");
            input.name = format!("via-{}", key.name);
            input.key_path = None;
            input.key_id = Some(key.id.clone());
            let hid = state.db.save_host(&input).unwrap();
            let s = Script::default();
            let conn =
                crate::ssh::connect(&app, &state.db.get_host(&hid).unwrap(), &s.channel(&app))
                    .await
                    .unwrap_or_else(|e| panic!("connect with {}: {e}", key.name));
            assert!(
                conn.auth_label.starts_with(&key.name),
                "{}",
                conn.auth_label
            );
            assert_eq!(s.count("prompt"), 0, "saved keys never prompt");
        }
        let counts: Vec<_> = state
            .db
            .list_keys()
            .unwrap()
            .iter()
            .map(|k| (k.name.clone(), k.host_count))
            .collect();
        assert!(counts.contains(&("Prod".into(), 1)), "{counts:?}");

        // Deleting a key in use moves its hosts back to automatic auth.
        state.db.delete_key(&protected.id).unwrap();
        let fallback = state
            .db
            .list_hosts()
            .unwrap()
            .into_iter()
            .find(|h| h.name == "via-Prod")
            .unwrap();
        assert_eq!((fallback.auth.as_str(), fallback.key_id.as_deref()), ("auto", None));

        // 9. SFTP rides on an open terminal's connection: no new login, and closing it
        //    leaves the terminal running.
        let script7 = Script::default();
        script7.push(true, &[]);
        let out2 = Arc::new(Mutex::new(Vec::<u8>::new()));
        let o2 = out2.clone();
        let data2 = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(b) = body {
                o2.lock().unwrap().extend(b);
            }
            Ok(())
        });
        terminal::open(
            app.clone(),
            "s2".into(),
            OpenArgs {
                host: host.clone(),
                cols: 80,
                rows: 24,
                data: data2,
                events: script7.channel(&app),
            },
        )
        .await
        .expect("second terminal connects");
        assert_eq!(state.connections.lock().unwrap().len(), 1);

        let script8 = Script::default();
        sftp::open(&app, host.clone(), "f2".into(), script8.channel(&app))
            .await
            .expect("shared sftp opens");
        assert_eq!(
            script8.count("hostKey") + script8.count("prompt"),
            0,
            "no second login"
        );
        assert!(!sftp::list(&app, "f2", &sftp_info.home)
            .await
            .unwrap()
            .is_empty());
        sftp::close(&app, "f2").await;

        let seen2 = |needle: &str| String::from_utf8_lossy(&out2.lock().unwrap()).contains(needle);
        for _ in 0..10 {
            terminal::send(
                &app,
                "s2",
                TerminalCmd::Input(b"echo still-$((1+1))\n".to_vec()),
            );
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if seen2("still-2") {
                break;
            }
        }
        assert!(
            seen2("still-2"),
            "terminal survives closing the shared sftp session"
        );
        terminal::close(&app, "s2");
        wait_for("connection released", || {
            state.connections.lock().unwrap().is_empty()
        })
        .await;
    });

    let _ = std::fs::remove_dir_all(&tmp);
}
