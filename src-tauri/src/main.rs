// Loom desktop shell (PRD §8 / M6): Tauri wrapper around the same web app.
// The native sidecar for CLAP hosting will live in this process later —
// the loom-dsp crate already exposes a C ABI for it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Loom");
}
