use std::process::Command;

#[test]
fn help_leads_with_the_attach_workflow() {
    let output = Command::new(env!("CARGO_BIN_EXE_devpipe"))
        .arg("--help")
        .output()
        .expect("run devpipe --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("devpipe attach <box>"));
    assert!(!stdout.contains("dpctl"));
}
