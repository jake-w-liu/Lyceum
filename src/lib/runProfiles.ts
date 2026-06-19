import type { EditorDoc } from "../state/editorStore";
import type { RuntimePaths, Settings } from "../state/settingsStore";
import { extensionForPath } from "./fileTypes";

export interface RunProfile {
  id: keyof RuntimePaths;
  label: string;
  languageIds: string[];
  fileExtensions: string[];
  defaultProgram: string;
  defaultProgramByExtension?: Partial<Record<string, string>>;
  fallbackPrograms?: string[];
  selectionFlag: string;
}

export interface RunProfileCommand {
  profile: RunProfile;
  program: string;
  fallbackPrograms: string[];
  args: string[];
  code?: string;
  file?: string;
  display: string;
}

export const RUN_PROFILES: RunProfile[] = [
  {
    id: "julia",
    label: "Julia",
    languageIds: ["julia"],
    fileExtensions: ["jl"],
    defaultProgram: "julia",
    selectionFlag: "-e",
  },
  {
    id: "python",
    label: "Python",
    languageIds: ["python"],
    fileExtensions: ["py"],
    defaultProgram: "python3",
    fallbackPrograms: ["python", "py"],
    selectionFlag: "-c",
  },
  {
    id: "node",
    label: "Node.js",
    languageIds: ["javascript"],
    fileExtensions: ["js", "mjs", "cjs"],
    defaultProgram: "node",
    selectionFlag: "-e",
  },
  {
    id: "shell",
    label: "Shell",
    languageIds: ["shell"],
    fileExtensions: ["sh", "bash", "zsh"],
    defaultProgram: "sh",
    defaultProgramByExtension: {
      bash: "bash",
      zsh: "zsh",
    },
    selectionFlag: "-c",
  },
  {
    id: "r",
    label: "R",
    languageIds: ["r"],
    fileExtensions: ["r"],
    defaultProgram: "Rscript",
    selectionFlag: "-e",
  },
];

export function runProfileForLanguage(
  languageId: string,
): RunProfile | undefined {
  return RUN_PROFILES.find((profile) => profile.languageIds.includes(languageId));
}

export function runProfileForPath(path: string): RunProfile | undefined {
  const ext = extensionForPath(path);
  if (!ext) return undefined;
  return RUN_PROFILES.find((profile) => profile.fileExtensions.includes(ext));
}

export function runProfileForDoc(doc: EditorDoc): RunProfile | undefined {
  return runProfileForPath(doc.path) ?? runProfileForLanguage(doc.language);
}

export function hasRunProfileForDoc(doc: EditorDoc | null | undefined): boolean {
  return !!doc && doc.kind === "text" && !!runProfileForDoc(doc);
}

function explicitRuntimePath(profile: RunProfile, settings: Settings): string {
  // NOTE: the shell profile must NOT fall back to settings.shellPath — that is
  // the INTERACTIVE terminal shell, which may be a non-POSIX shell (fish/nu/csh)
  // the backend run-profile allowlist rejects (only sh/bash/zsh). When
  // runtimePaths.shell is unset, fall through to the sh/bash/zsh default instead.
  return settings.runtimePaths[profile.id].trim();
}

function defaultProgramForPath(profile: RunProfile, path: string): string {
  const ext = extensionForPath(path);
  return profile.defaultProgramByExtension?.[ext] ?? profile.defaultProgram;
}

function runtimePathForProfile(
  profile: RunProfile,
  settings: Settings,
  path: string,
): string {
  return explicitRuntimePath(profile, settings) || defaultProgramForPath(profile, path);
}

function fallbackProgramsForProfile(
  profile: RunProfile,
  settings: Settings,
): string[] {
  const explicit = explicitRuntimePath(profile, settings);
  return explicit ? [] : profile.fallbackPrograms ?? [];
}

function quoteDisplayArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return JSON.stringify(arg);
}

export function buildRunProfileCommand(
  doc: EditorDoc,
  selection: string,
  settings: Settings,
): RunProfileCommand | null {
  const profile = runProfileForDoc(doc);
  if (!profile) return null;

  const code = selection.trim().length > 0 ? selection : undefined;
  const file = code ? undefined : doc.path;
  const program = runtimePathForProfile(profile, settings, doc.path);
  const fallbackPrograms = fallbackProgramsForProfile(profile, settings);
  const args = code ? [profile.selectionFlag, code] : [doc.path];
  const displayArgs = code ? [profile.selectionFlag, "<selection>"] : [doc.name];
  return {
    profile,
    program,
    fallbackPrograms,
    args,
    code,
    file,
    display: [program, ...displayArgs].map(quoteDisplayArg).join(" "),
  };
}

export function missingRuntimeMessage(
  profile: RunProfile,
  errorMessage: string,
): string | null {
  if (!/No such file|os error 2|not found|failed to start/i.test(errorMessage)) {
    return null;
  }
  const setting = `runtimePaths.${profile.id}`;
  return [
    `${profile.label} runtime was not found.`,
    `Install ${profile.label} or set ${setting} in settings to a matching runtime executable path.`,
  ].join(" ");
}
