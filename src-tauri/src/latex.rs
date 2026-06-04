// Lightweight LaTeX build orchestration.
//
// Lyceum does not implement a TeX engine. Instead, this module is the native
// builder layer around installed cross-platform engines. For the stock default
// command we avoid a shell entirely: resolve a compiler from PATH, spawn it with
// typed args, remove stale PDFs first, and stream output through the same
// managed process registry used by Julia runs.

use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::julia::{self, RunManager};

const STOCK_LATEX_BUILD_COMMAND: &str = "latexmk -pdf main.tex";
const LATEX_TOOL_ORDER: [&str; 5] = ["latexmk", "tectonic", "pdflatex", "xelatex", "lualatex"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LatexToolDto {
    pub tool: String,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LatexBuildPlanDto {
    pub command: String,
    pub cwd: String,
    pub pdf_path: String,
    pub removed_stale_pdf: bool,
    pub tool: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LatexBuildPlan {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    pdf_path: PathBuf,
    command: String,
    tool: String,
    source: String,
}

#[derive(Clone, Serialize)]
struct OutputLine {
    stream: String,
    line: String,
}

/// Return usable installed LaTeX tools in Lyceum's priority order.
#[tauri::command]
pub fn resolve_latex_tools() -> Vec<LatexToolDto> {
    let path = process_path();
    resolve_latex_tools_impl(&path)
}

/// Compile one concrete `.tex` file. The frontend must save the editor buffer
/// before invoking this command.
#[tauri::command]
pub fn run_latex_build(
    app: AppHandle,
    state: State<RunManager>,
    id: String,
    tex_path: String,
    configured_command: String,
) -> Result<LatexBuildPlanDto, String> {
    let path = process_path();
    let plan = plan_latex_build_impl(Path::new(&tex_path), &configured_command, &path)?;
    let removed_stale_pdf = remove_stale_pdf(&plan.pdf_path)?;

    let out_event = format!("build:output:{id}");
    emit_output(
        &app,
        &out_event,
        "stdout",
        format!("$ {}   (cwd: {})", plan.command, plan.cwd.display()),
    );
    if removed_stale_pdf {
        emit_output(
            &app,
            &out_event,
            "stdout",
            format!("[latex] removed stale {}", plan.pdf_path.display()),
        );
    }

    let mut command = Command::new(&plan.program);
    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", plan.program))?;

    julia::stream_child(
        app,
        child,
        id.clone(),
        state.runs.clone(),
        out_event,
        format!("build:exit:{id}"),
    );

    Ok(plan.to_dto(removed_stale_pdf))
}

fn process_path() -> std::ffi::OsString {
    julia::augmented_path(
        env::var_os("PATH").as_deref(),
        env::var_os("HOME").as_deref(),
    )
}

fn resolve_latex_tools_impl(path: &OsStr) -> Vec<LatexToolDto> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for tool in LATEX_TOOL_ORDER {
        if let Some(program) = julia::find_program_in_path(tool, path) {
            let program = program.to_string_lossy().to_string();
            if seen.insert((tool.to_string(), program.clone())) {
                out.push(LatexToolDto {
                    tool: tool.to_string(),
                    path: program,
                    source: "path".to_string(),
                });
            }
        }
    }

    out
}

fn plan_latex_build_impl(
    tex_path: &Path,
    configured_command: &str,
    process_path: &OsStr,
) -> Result<LatexBuildPlan, String> {
    validate_tex_path(tex_path)?;
    let cwd = tex_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            format!(
                "cannot determine parent directory for {}",
                tex_path.display()
            )
        })?
        .to_path_buf();
    let tex_name = tex_file_name(tex_path)?;
    let pdf_path = pdf_path_for_tex(tex_path)?;

    if is_stock_latex_command(configured_command) {
        return plan_auto_latex_build(&tex_name, cwd, pdf_path, process_path);
    }

    let command = retarget_tex_command(configured_command, &tex_name);
    let (program, args) = shell_command(&command);
    Ok(LatexBuildPlan {
        program,
        args,
        cwd,
        pdf_path,
        command,
        tool: "custom".to_string(),
        source: "shell".to_string(),
    })
}

fn plan_auto_latex_build(
    tex_name: &str,
    cwd: PathBuf,
    pdf_path: PathBuf,
    process_path: &OsStr,
) -> Result<LatexBuildPlan, String> {
    let tool = resolve_latex_tools_impl(process_path)
        .into_iter()
        .next()
        .ok_or_else(no_latex_compiler_message)?;
    let args = args_for_tool(&tool.tool, tex_name)?;
    let command = display_command(&tool.path, &args);

    Ok(LatexBuildPlan {
        program: tool.path,
        args,
        cwd,
        pdf_path,
        command,
        tool: tool.tool,
        source: tool.source,
    })
}

fn args_for_tool(tool: &str, tex_name: &str) -> Result<Vec<String>, String> {
    match tool {
        "latexmk" => Ok(vec!["-pdf".to_string(), tex_name.to_string()]),
        "tectonic" => Ok(vec![tex_name.to_string()]),
        "pdflatex" | "xelatex" | "lualatex" => Ok(vec![
            "-interaction=nonstopmode".to_string(),
            "-halt-on-error".to_string(),
            tex_name.to_string(),
        ]),
        _ => Err(format!("unsupported LaTeX tool: {tool}")),
    }
}

fn validate_tex_path(path: &Path) -> Result<(), String> {
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("tex"))
        .unwrap_or(false)
    {
        return Err(format!("not a .tex file: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("file not found: {}", path.display()));
    }
    Ok(())
}

fn tex_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
        .ok_or_else(|| format!("cannot determine file name for {}", path.display()))
}

fn pdf_path_for_tex(path: &Path) -> Result<PathBuf, String> {
    let mut pdf = path.to_path_buf();
    pdf.set_extension("pdf");
    Ok(pdf)
}

fn remove_stale_pdf(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    if path.is_dir() {
        return Err(format!(
            "expected a file, found directory: {}",
            path.display()
        ));
    }
    std::fs::remove_file(path)
        .map(|_| true)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn emit_output(app: &AppHandle, event: &str, stream: &str, line: String) {
    let _ = app.emit(
        event,
        OutputLine {
            stream: stream.to_string(),
            line,
        },
    );
}

fn no_latex_compiler_message() -> String {
    "No LaTeX compiler was found. Install Tectonic, MacTeX/BasicTeX, or set latexBuildCommand to an absolute compiler path.".to_string()
}

fn is_stock_latex_command(command: &str) -> bool {
    canonical_shell_command(command) == STOCK_LATEX_BUILD_COMMAND
}

fn canonical_shell_command(command: &str) -> String {
    command
        .split_whitespace()
        .map(strip_shell_quotes)
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_shell_quotes(value: &str) -> &str {
    if ((value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\'')))
        && value.len() >= 2
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn retarget_tex_command(command: &str, tex_name: &str) -> String {
    let mut tokens: Vec<String> = command
        .split_whitespace()
        .map(|token| token.to_string())
        .collect();
    for token in tokens.iter_mut().rev() {
        if strip_shell_quotes(token).to_lowercase().ends_with(".tex") {
            *token = quote_shell_arg(tex_name);
            return tokens.join(" ");
        }
    }
    tokens.push(quote_shell_arg(tex_name));
    tokens.join(" ")
}

fn shell_command(command: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        (
            "cmd".to_string(),
            vec!["/C".to_string(), command.to_string()],
        )
    } else {
        (
            "sh".to_string(),
            vec!["-c".to_string(), command.to_string()],
        )
    }
}

fn display_command(program: &str, args: &[String]) -> String {
    std::iter::once(quote_shell_executable(program))
        .chain(args.iter().map(|arg| quote_shell_arg(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_shell_executable(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_./:\\-".contains(c))
    {
        value.to_string()
    } else {
        quote_shell_arg(value)
    }
}

fn quote_shell_arg(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        if matches!(ch, '"' | '\\' | '$' | '`') {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    quoted
}

impl LatexBuildPlan {
    fn to_dto(&self, removed_stale_pdf: bool) -> LatexBuildPlanDto {
        LatexBuildPlanDto {
            command: self.command.clone(),
            cwd: self.cwd.to_string_lossy().to_string(),
            pdf_path: self.pdf_path.to_string_lossy().to_string(),
            removed_stale_pdf,
            tool: self.tool.clone(),
            source: self.source.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_executable(path: &std::path::Path) {
        std::fs::write(path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[test]
    fn resolves_path_tools_in_priority_order() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        make_executable(&bin.join("pdflatex"));
        make_executable(&bin.join("latexmk"));
        let path = env::join_paths([bin.as_path()]).unwrap();

        let tools = resolve_latex_tools_impl(&path);

        assert_eq!(tools[0].tool, "latexmk");
        assert_eq!(tools[0].source, "path");
        assert_eq!(tools[1].tool, "pdflatex");
    }

    #[test]
    fn stock_build_uses_first_available_tool_without_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        make_executable(&bin.join("tectonic"));
        std::fs::write(work.join("main.tex"), "\\documentclass{article}").unwrap();
        let path = env::join_paths([bin.as_path()]).unwrap();

        let plan = plan_latex_build_impl(&work.join("main.tex"), STOCK_LATEX_BUILD_COMMAND, &path)
            .unwrap();

        assert_eq!(plan.program, bin.join("tectonic").to_string_lossy());
        assert_eq!(plan.args, vec!["main.tex"]);
        assert_eq!(plan.cwd, work);
        assert_eq!(plan.pdf_path, tmp.path().join("work/main.pdf"));
        assert_eq!(plan.tool, "tectonic");
    }

    #[test]
    fn stock_build_errors_before_spawn_when_no_compiler_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let err =
            plan_latex_build_impl(&tex, STOCK_LATEX_BUILD_COMMAND, OsStr::new("")).unwrap_err();

        assert!(err.contains("No LaTeX compiler was found"));
    }

    #[test]
    fn custom_build_retargets_current_tex_file_and_uses_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan =
            plan_latex_build_impl(&tex, "latexmk -pdf -silent main.tex", OsStr::new("")).unwrap();

        assert_eq!(plan.program, if cfg!(windows) { "cmd" } else { "sh" });
        assert!(plan.command.ends_with("\"paper.tex\""));
        assert_eq!(plan.tool, "custom");
        assert_eq!(plan.source, "shell");
    }

    #[test]
    fn stale_pdf_removal_is_file_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("paper.pdf");
        std::fs::write(&pdf, b"old").unwrap();

        assert!(remove_stale_pdf(&pdf).unwrap());
        assert!(!pdf.exists());

        assert!(!remove_stale_pdf(&pdf).unwrap());
    }
}
