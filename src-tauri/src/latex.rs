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
use crate::path_access::{self, PathAccessManager};

const STOCK_LATEX_BUILD_COMMAND: &str = "latexmk -pdf main.tex";
const LATEX_TOOL_ORDER: [&str; 5] = ["latexmk", "tectonic", "pdflatex", "xelatex", "lualatex"];
// Value-taking flags in the SPACE-separated form (`-flag value`). Shared by
// tex_placeholder_index (so a value ending in .tex isn't mistaken for the input)
// and custom_pdf_path (so PDF prediction and input selection can't diverge).
const OUTDIR_FLAGS: [&str; 3] = ["-output-directory", "-outdir", "--outdir"];
const JOBNAME_FLAGS: [&str; 1] = ["-jobname"];

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

/// Compile one concrete `.tex` file. The frontend must save the editor buffer
/// before invoking this command.
#[tauri::command]
pub fn run_latex_build(
    app: AppHandle,
    window: tauri::Window,
    state: State<RunManager>,
    access: State<PathAccessManager>,
    id: String,
    tex_path: String,
    configured_command: String,
) -> Result<LatexBuildPlanDto, String> {
    let path = process_path();
    let tex_path =
        path_access::ensure_existing_file_allowed(&app, &window, &access, Path::new(&tex_path))?;
    let mut plan = plan_latex_build_impl(&tex_path, &configured_command, &path)?;
    plan.pdf_path =
        path_access::ensure_write_target_allowed(&app, &window, &access, &plan.pdf_path)?;
    let removed_stale_pdf = remove_stale_pdf(&plan.pdf_path)?;

    let label = window.label().to_string();
    let out_event = format!("build:output:{id}");
    emit_output(
        &app,
        &label,
        &out_event,
        "stdout",
        format!("$ {}   (cwd: {})", plan.command, plan.cwd.display()),
    );
    if removed_stale_pdf {
        emit_output(
            &app,
            &label,
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
    // Own process group so cancel can kill the whole tree (latexmk -> pdflatex/biber).
    julia::configure_process_group(&mut command);
    let child = command
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", plan.program))?;

    julia::stream_child(
        app,
        label,
        child,
        julia::run_key(&window, &id),
        state.runs.clone(),
        state.pending_cancel.clone(),
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

    // `command` is the DISPLAY string only (shell-quoted tex name): shown to the
    // user and parsed for -output-directory/-jobname to locate the PDF.
    let command = retarget_tex_command(configured_command, &tex_name);
    // A custom command may relocate/rename the PDF via -output-directory/-jobname;
    // honor those so stale-removal, the "wrote …" message, and auto-open all point
    // at the real artifact instead of the default next-to-source path.
    let pdf_path = custom_pdf_path(&command, &tex_name, &cwd).unwrap_or(pdf_path);
    // Build the EXECUTED args from the configured command's unquoted tokens,
    // substituting the RAW tex name for the .tex token. Routing the name through
    // retarget's shell-quoting and then strip_shell_quotes (which removes only
    // OUTER quotes) would leave quote_shell_arg's backslash escapes ($, \, ", `)
    // literally in the args, so a file named `a$b.tex` would be spawned as the
    // non-existent `a\$b.tex`. Args go straight to execve (no shell), so the raw
    // name is exactly what the compiler must receive.
    let (program, args, tool) = parse_custom_latex_command(configured_command, &tex_name)?;
    Ok(LatexBuildPlan {
        program,
        args,
        cwd,
        pdf_path,
        command,
        tool,
        source: "custom".to_string(),
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

/// For a custom (non-stock) build command, derive the real PDF output path by
/// honoring `-output-directory`/`-outdir`/`--outdir` and `-jobname`, which move
/// or rename the artifact away from the default `<texdir>/<stem>.pdf`. Both the
/// `-flag=value` and `-flag value` forms are recognized; a relative output dir is
/// resolved against `cwd` (the .tex's parent, where the build runs). Returns
/// `None` when no such flag is present, so the caller keeps the default path.
/// Without this, Lyceum would delete/predict/auto-open the wrong PDF for commands
/// like `latexmk -pdf -output-directory=build main.tex`.
fn custom_pdf_path(command: &str, tex_name: &str, cwd: &Path) -> Option<PathBuf> {
    let tokens: Vec<String> = shell_token_spans(command)
        .iter()
        .map(|span| unquote_token(&command[span.start..span.end]))
        .collect();

    let mut outdir: Option<String> = None;
    let mut jobname: Option<String> = None;
    let mut i = 0;
    while i < tokens.len() {
        let tok = &tokens[i];
        let next = tokens.get(i + 1);
        let mut consumed_next = false;
        if outdir.is_none() {
            for flag in OUTDIR_FLAGS {
                if let Some((value, used_next)) = flag_value(tok, next, flag) {
                    outdir = Some(value);
                    consumed_next = used_next;
                    break;
                }
            }
        }
        if !consumed_next && jobname.is_none() {
            for flag in JOBNAME_FLAGS {
                if let Some((value, used_next)) = flag_value(tok, next, flag) {
                    jobname = Some(value);
                    consumed_next = used_next;
                    break;
                }
            }
        }
        i += if consumed_next { 2 } else { 1 };
    }

    if outdir.is_none() && jobname.is_none() {
        return None;
    }

    let stem = Path::new(tex_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(tex_name)
        .to_string();
    let base = jobname.unwrap_or(stem);
    let dir = match outdir {
        Some(d) => {
            let p = PathBuf::from(&d);
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        }
        None => cwd.to_path_buf(),
    };
    Some(dir.join(format!("{base}.pdf")))
}

fn parse_custom_latex_command(
    command: &str,
    tex_name: &str,
) -> Result<(String, Vec<String>, String), String> {
    let mut tokens: Vec<String> = shell_token_spans(command)
        .iter()
        .map(|span| unquote_token(&command[span.start..span.end]))
        .collect();
    // Substitute the real tex file name for the user's input placeholder (e.g.
    // `main.tex`), or append it if the command has none. Uses the SAME
    // tex_placeholder_index as the display retarget so the executed input file can
    // never diverge from the displayed one. The RAW name keeps the spawned args
    // free of shell-escaping artifacts.
    match tex_placeholder_index(command) {
        Some(idx) => tokens[idx] = tex_name.to_string(),
        None => tokens.push(tex_name.to_string()),
    }
    let (program, args) = tokens
        .split_first()
        .ok_or_else(|| "latexBuildCommand must start with a LaTeX compiler".to_string())?;
    let tool = latex_tool_name(program).ok_or_else(|| {
        format!(
            "latexBuildCommand must start with one of: {}",
            LATEX_TOOL_ORDER.join(", ")
        )
    })?;
    Ok((program.clone(), args.to_vec(), tool))
}

fn latex_tool_name(program: &str) -> Option<String> {
    let name = Path::new(program).file_name()?.to_str()?;
    // Lowercase BEFORE stripping `.exe` so an uppercase/mixed-case extension
    // (e.g. `LATEXMK.EXE` on case-insensitive Windows) still maps to the tool.
    let lowered = name.to_ascii_lowercase();
    let lower = lowered.strip_suffix(".exe").unwrap_or(&lowered).to_string();
    LATEX_TOOL_ORDER
        .iter()
        .find(|tool| **tool == lower)
        .map(|tool| (*tool).to_string())
}

/// Extract a flag's value, supporting `-flag=value` (returns `(value, false)`)
/// and `-flag value` (returns `(value, true)` to signal the next token was
/// consumed). Returns `None` if `tok` is not this flag.
fn flag_value(tok: &str, next: Option<&String>, flag: &str) -> Option<(String, bool)> {
    let rest = tok.strip_prefix(flag)?;
    if let Some(value) = rest.strip_prefix('=') {
        // `tok` was already fully unquoted by `unquote_token`, so the inline value
        // (`-flag=value`) needs no further stripping.
        return Some((value.to_string(), false));
    }
    if rest.is_empty() {
        // `-flag value`: the next token (already shell-unquoted) is the value.
        return next.map(|value| (value.clone(), true));
    }
    None
}

fn remove_stale_pdf(path: &Path) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    if metadata.file_type().is_dir() {
        return Err(format!(
            "expected a file, found directory: {}",
            path.display()
        ));
    }
    std::fs::remove_file(path)
        .map(|_| true)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn emit_output(app: &AppHandle, label: &str, event: &str, stream: &str, line: String) {
    let _ = app.emit_to(
        label,
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

/// Full inverse of the splitting performed by `shell_token_spans`: removes quote
/// delimiters AND (on non-Windows) the backslash before an escaped character, so
/// a token reaches the executed process args as the exact string the user meant.
/// `strip_shell_quotes` only removes a matching OUTER quote pair (and is kept for
/// stock-command canonicalization); it leaves backslash escapes in place, which
/// would otherwise corrupt e.g. a backslash-escaped program path or -output-dir.
/// Mirrors the tokenizer's state machine exactly (escape checked before quotes).
fn unquote_token(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in token.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if !cfg!(windows) && ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                out.push(ch);
            }
            continue;
        }
        if matches!(ch, '"' | '\'') {
            quote = Some(ch);
            continue;
        }
        out.push(ch);
    }
    out
}

/// Index (in `shell_token_spans` order) of the token holding the user's input
/// `.tex` placeholder: the LAST PLAIN OPERAND whose unquoted value ends in
/// ".tex". A flag value is never chosen — neither the inline form `-o="x.tex"`
/// (its token starts with '-') NOR the space-separated form `-output-directory
/// build.tex` / `-jobname draft.tex` (the value token does not start with '-', so
/// it is detected by skipping the token after a known value-taking flag). Returns
/// None when no such operand exists (the caller appends the real name). SHARED by
/// the display retarget AND the executed-arg substitution so the two can never
/// pick different tokens, and uses the SAME flag set as custom_pdf_path so input
/// selection and PDF prediction can't diverge.
fn tex_placeholder_index(command: &str) -> Option<usize> {
    let tokens: Vec<String> = shell_token_spans(command)
        .iter()
        .map(|span| unquote_token(&command[span.start..span.end]))
        .collect();
    // Mark each token that is the VALUE of a space-separated value-taking flag.
    let mut is_flag_value = vec![false; tokens.len()];
    for i in 0..tokens.len() {
        let tok = tokens[i].as_str();
        if (OUTDIR_FLAGS.contains(&tok) || JOBNAME_FLAGS.contains(&tok)) && i + 1 < tokens.len() {
            is_flag_value[i + 1] = true;
        }
    }
    tokens
        .iter()
        .enumerate()
        .rev()
        .find(|(idx, tok)| {
            !is_flag_value[*idx] && !tok.starts_with('-') && tok.to_lowercase().ends_with(".tex")
        })
        .map(|(idx, _)| idx)
}

fn retarget_tex_command(command: &str, tex_name: &str) -> String {
    let replacement = quote_shell_arg(tex_name);
    if let Some(idx) = tex_placeholder_index(command) {
        let span = shell_token_spans(command)[idx];
        let mut out = String::with_capacity(command.len() + replacement.len());
        out.push_str(&command[..span.start]);
        out.push_str(&replacement);
        out.push_str(&command[span.end..]);
        return out;
    }
    if command.trim().is_empty() {
        replacement
    } else {
        format!("{} {}", command.trim_end(), replacement)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TokenSpan {
    start: usize,
    end: usize,
}

fn shell_token_spans(command: &str) -> Vec<TokenSpan> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for (idx, ch) in command.char_indices() {
        if start.is_none() {
            if ch.is_whitespace() {
                continue;
            }
            start = Some(idx);
        }

        if escaped {
            escaped = false;
            continue;
        }
        if !cfg!(windows) && ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '"' | '\'') {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if let Some(start) = start.take() {
                spans.push(TokenSpan { start, end: idx });
            }
        }
    }

    if let Some(start) = start {
        spans.push(TokenSpan {
            start,
            end: command.len(),
        });
    }

    spans
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
    quote_shell_arg_for(value, cfg!(windows))
}

fn quote_shell_arg_for(value: &str, windows: bool) -> String {
    if windows {
        return format!("\"{}\"", value.replace('"', "\\\""));
    }
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
    fn custom_build_retargets_current_tex_file_without_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan =
            plan_latex_build_impl(&tex, "latexmk -pdf -silent main.tex", OsStr::new("")).unwrap();

        assert_eq!(plan.program, "latexmk");
        assert_eq!(plan.args, vec!["-pdf", "-silent", "paper.tex"]);
        assert!(plan.command.ends_with("\"paper.tex\""));
        assert_eq!(plan.tool, "latexmk");
        assert_eq!(plan.source, "custom");
    }

    #[test]
    fn custom_build_does_not_treat_a_quoted_flag_value_ending_in_tex_as_input() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("real.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        // A -o flag whose quoted value ends in .tex must NOT be mistaken for the
        // input placeholder; the real input (main.tex) is replaced. Display and
        // executed args must agree on which token was substituted (they used to
        // diverge: display via strip_shell_quotes, exec via unquote_token).
        let plan =
            plan_latex_build_impl(&tex, r#"latexmk main.tex -o="x.tex""#, OsStr::new("")).unwrap();

        assert_eq!(plan.program, "latexmk");
        assert_eq!(plan.args, vec!["real.tex", "-o=x.tex"]);
        assert!(plan.command.contains("\"real.tex\""));
        assert!(plan.command.contains("-o=\"x.tex\""));
    }

    #[test]
    fn custom_build_does_not_treat_a_space_separated_flag_value_ending_in_tex_as_input() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        // `-output-directory build.tex` — the flag VALUE ends in .tex but is the
        // directory, not the input file. main.tex is the input and must be the one
        // replaced; the flag value must be left intact.
        let plan = plan_latex_build_impl(
            &tex,
            "latexmk main.tex -output-directory build.tex",
            OsStr::new(""),
        )
        .unwrap();

        assert_eq!(
            plan.args,
            vec!["paper.tex", "-output-directory", "build.tex"]
        );
    }

    #[test]
    fn custom_build_retargets_quoted_tex_arguments_with_spaces() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("new paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan = plan_latex_build_impl(
            &tex,
            r#""/Applications/TeX Tools/latexmk" -pdf "old main.tex" -silent"#,
            OsStr::new(""),
        )
        .unwrap();

        assert_eq!(
            plan.command,
            r#""/Applications/TeX Tools/latexmk" -pdf "new paper.tex" -silent"#
        );
        assert_eq!(plan.program, "/Applications/TeX Tools/latexmk");
        assert_eq!(plan.args, vec!["-pdf", "new paper.tex", "-silent"]);
        assert_eq!(plan.tool, "latexmk");
    }

    #[test]
    fn custom_build_appends_current_file_when_no_tex_argument_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan = plan_latex_build_impl(&tex, "tectonic --keep-logs", OsStr::new("")).unwrap();

        assert_eq!(plan.command, r#"tectonic --keep-logs "paper.tex""#);
        assert_eq!(plan.program, "tectonic");
        assert_eq!(plan.args, vec!["--keep-logs", "paper.tex"]);
    }

    #[test]
    fn custom_build_passes_raw_filename_with_shell_metacharacters() {
        // A legal .tex name containing a shell metacharacter ($) must reach the
        // compiler verbatim in the spawned args — they go straight to execve with
        // no shell. Before the fix, the name was shell-quoted by retarget and then
        // only OUTER-quote-stripped, leaving the escape literally in the arg
        // (`a\$b.tex`), so the compiler built a non-existent file.
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("a$b.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan =
            plan_latex_build_impl(&tex, "latexmk -pdf -silent main.tex", OsStr::new("")).unwrap();

        assert_eq!(plan.args, vec!["-pdf", "-silent", "a$b.tex"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn custom_build_unescapes_backslash_escaped_tokens() {
        // The tokenizer treats backslash as an escape (so a backslash-escaped
        // space keeps a token together); the executed tokens must therefore have
        // those backslashes REMOVED — they go to execve, not a shell. Affects the
        // program path and -output-directory value (the .tex token is replaced).
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan = plan_latex_build_impl(
            &tex,
            r"/My\ Tools/latexmk -output-directory=my\ dir main.tex",
            OsStr::new(""),
        )
        .unwrap();

        assert_eq!(plan.program, "/My Tools/latexmk");
        assert_eq!(plan.args, vec!["-output-directory=my dir", "paper.tex"]);
    }

    #[test]
    fn custom_build_rejects_non_latex_programs() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let err = plan_latex_build_impl(&tex, "sh -c 'latexmk -pdf main.tex'", OsStr::new(""))
            .unwrap_err();

        assert!(err.contains("latexBuildCommand must start with one of"));
    }

    #[test]
    fn latex_tool_name_strips_exe_case_insensitively() {
        // Windows filenames are case-insensitive, so an uppercase/mixed-case .exe
        // must still map to the tool (the strip used to be case-sensitive).
        assert_eq!(latex_tool_name("LATEXMK.EXE").as_deref(), Some("latexmk"));
        assert_eq!(latex_tool_name("Tectonic.Exe").as_deref(), Some("tectonic"));
        assert_eq!(latex_tool_name("latexmk").as_deref(), Some("latexmk"));
        assert_eq!(latex_tool_name("notatool").as_deref(), None);
    }

    #[test]
    fn custom_build_with_output_directory_predicts_pdf_in_that_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan = plan_latex_build_impl(
            &tex,
            "latexmk -pdf -output-directory=build main.tex",
            OsStr::new(""),
        )
        .unwrap();

        // Output dir is relative to cwd (the .tex parent); stem comes from the
        // retargeted current file (paper), not "main".
        assert_eq!(plan.pdf_path, tmp.path().join("build").join("paper.pdf"));
    }

    #[test]
    fn custom_build_with_jobname_predicts_renamed_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan = plan_latex_build_impl(
            &tex,
            "latexmk -pdf -jobname report main.tex",
            OsStr::new(""),
        )
        .unwrap();

        assert_eq!(plan.pdf_path, tmp.path().join("report.pdf"));
    }

    #[test]
    fn custom_build_without_outdir_keeps_default_pdf_next_to_source() {
        let tmp = tempfile::tempdir().unwrap();
        let tex = tmp.path().join("paper.tex");
        std::fs::write(&tex, "\\documentclass{article}").unwrap();

        let plan =
            plan_latex_build_impl(&tex, "latexmk -pdf -silent main.tex", OsStr::new("")).unwrap();

        assert_eq!(plan.pdf_path, tmp.path().join("paper.pdf"));
    }

    #[test]
    fn shell_argument_quoting_is_platform_aware() {
        assert_eq!(
            quote_shell_arg_for(r"C:\tmp\a$b.tex", true),
            r#""C:\tmp\a$b.tex""#
        );
        assert_eq!(
            quote_shell_arg_for(r#"a "$`\ file.tex"#, false),
            r#""a \"\$\`\\ file.tex""#
        );
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

    #[cfg(unix)]
    #[test]
    fn stale_pdf_removal_unlinks_symlinks_without_touching_targets() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target.pdf");
        let linked_pdf = tmp.path().join("paper.pdf");
        std::fs::write(&target, b"target").unwrap();
        symlink(&target, &linked_pdf).unwrap();

        assert!(remove_stale_pdf(&linked_pdf).unwrap());
        assert!(std::fs::symlink_metadata(&linked_pdf).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"target");

        let broken_pdf = tmp.path().join("broken.pdf");
        symlink(tmp.path().join("missing.pdf"), &broken_pdf).unwrap();
        assert!(!broken_pdf.exists());

        assert!(remove_stale_pdf(&broken_pdf).unwrap());
        assert!(std::fs::symlink_metadata(&broken_pdf).is_err());
    }
}
