#[cfg(windows)]
pub mod windows;

#[cfg(windows)]
pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    duo_utils::platform::silent_command(program)
}

#[cfg(not(windows))]
pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    duo_utils::platform::silent_command(program)
}
