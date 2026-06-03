// Registers Monaco Monarch grammars for languages Monaco lacks: Julia, LaTeX, TOML.
import type * as Monaco from "monaco-editor";

let registered = false;

export function registerLanguages(monaco: typeof Monaco): void {
  if (registered) {
    return;
  }
  registered = true;

  registerJulia(monaco);
  registerLatex(monaco);
  registerToml(monaco);
}

function registerJulia(monaco: typeof Monaco): void {
  const id = "julia";
  monaco.languages.register({ id });

  const tokenizer: Monaco.languages.IMonarchLanguage = {
    defaultToken: "",
    keywords: [
      "function", "end", "if", "elseif", "else", "while", "for", "in",
      "return", "using", "import", "module", "baremodule", "struct",
      "mutable", "abstract", "primitive", "type", "begin", "let", "do",
      "macro", "quote", "const", "global", "local", "try", "catch",
      "finally", "where",
    ],
    operators: [
      "=", "==", "===", "!=", "!==", "<", "<=", ">", ">=", "+", "-", "*",
      "/", "\\", "^", "%", "//", "<<", ">>", "&", "|", "~", "&&", "||",
      "->", "<:", ">:", "::", "...", ".", "?",
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    tokenizer: {
      root: [
        [/@[a-zA-Z_]\w*/, "annotation"],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@default": "identifier",
            },
          },
        ],
        { include: "@whitespace" },
        [/[{}()[\]]/, "@brackets"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/\d+\.\d*([eE][-+]?\d+)?/, "number.float"],
        [/\.\d+([eE][-+]?\d+)?/, "number.float"],
        [/\d+[eE][-+]?\d+/, "number.float"],
        [/\d+/, "number"],
        [
          /@symbols/,
          {
            cases: {
              "@operators": "operator",
              "@default": "",
            },
          },
        ],
        [/"""/, { token: "string.quote", next: "@tripleString" }],
        [/"/, { token: "string.quote", next: "@string" }],
      ],
      whitespace: [
        [/[ \t\r\n]+/, "white"],
        [/#=/, { token: "comment", next: "@blockComment" }],
        [/#.*$/, "comment"],
      ],
      blockComment: [
        [/[^#=]+/, "comment"],
        [/#=/, { token: "comment", next: "@push" }],
        [/=#/, { token: "comment", next: "@pop" }],
        [/[#=]/, "comment"],
      ],
      string: [
        [/[^\\"$]+/, "string"],
        [/\\./, "string.escape"],
        [/\$\([^)]*\)/, "variable"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
      tripleString: [
        [/[^\\"$]+/, "string"],
        [/\\./, "string.escape"],
        [/\$\([^)]*\)/, "variable"],
        [/"""/, { token: "string.quote", next: "@pop" }],
        [/"/, "string"],
      ],
    },
  };
  monaco.languages.setMonarchTokensProvider(id, tokenizer);

  const config: Monaco.languages.LanguageConfiguration = {
    comments: {
      lineComment: "#",
      blockComment: ["#=", "=#"],
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
  };
  monaco.languages.setLanguageConfiguration(id, config);
}

function registerLatex(monaco: typeof Monaco): void {
  const id = "latex";
  monaco.languages.register({ id });

  const tokenizer: Monaco.languages.IMonarchLanguage = {
    defaultToken: "",
    tokenizer: {
      root: [
        [/%.*$/, "comment"],
        [/\\(begin|end)(\s*)(\{)/, ["keyword", "white", "@brackets"]],
        [/\\[a-zA-Z]+/, "keyword"],
        [/\\./, "keyword"],
        [/\$\$/, { token: "string", next: "@displayMath" }],
        [/\$/, { token: "string", next: "@inlineMath" }],
        [/[{}[\]]/, "@brackets"],
        [/[a-zA-Z_]\w*/, "identifier"],
      ],
      inlineMath: [
        [/%.*$/, "comment"],
        [/\\[a-zA-Z]+/, "keyword"],
        [/\\./, "keyword"],
        [/[^$\\]+/, "string"],
        [/\$/, { token: "string", next: "@pop" }],
      ],
      displayMath: [
        [/%.*$/, "comment"],
        [/\\[a-zA-Z]+/, "keyword"],
        [/\\./, "keyword"],
        [/[^$\\]+/, "string"],
        [/\$\$/, { token: "string", next: "@pop" }],
        [/\$/, "string"],
      ],
    },
  };
  monaco.languages.setMonarchTokensProvider(id, tokenizer);

  const config: Monaco.languages.LanguageConfiguration = {
    comments: {
      lineComment: "%",
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "$", close: "$" },
    ],
  };
  monaco.languages.setLanguageConfiguration(id, config);
}

function registerToml(monaco: typeof Monaco): void {
  const id = "toml";
  monaco.languages.register({ id });

  const tokenizer: Monaco.languages.IMonarchLanguage = {
    defaultToken: "",
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\[\[[^\]]*\]\]/, "type"],
        [/\[[^\]]*\]/, "namespace"],
        [/[A-Za-z0-9_-]+(?=\s*=)/, "identifier"],
        [
          /\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[-+]\d{2}:\d{2})?)?/,
          "number.date",
        ],
        [/\b(true|false)\b/, "keyword"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/0[oO][0-7]+/, "number.octal"],
        [/0[bB][01]+/, "number.binary"],
        [/[-+]?\d+\.\d*([eE][-+]?\d+)?/, "number.float"],
        [/[-+]?\d+([eE][-+]?\d+)?/, "number"],
        [/=/, "operator"],
        [/[{}[\],]/, "@brackets"],
        [/"""/, { token: "string.quote", next: "@tripleBasicString" }],
        [/'''/, { token: "string.quote", next: "@tripleLiteralString" }],
        [/"/, { token: "string.quote", next: "@basicString" }],
        [/'/, { token: "string.quote", next: "@literalString" }],
      ],
      basicString: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
      literalString: [
        [/[^']+/, "string"],
        [/'/, { token: "string.quote", next: "@pop" }],
      ],
      tripleBasicString: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"""/, { token: "string.quote", next: "@pop" }],
        [/"/, "string"],
      ],
      tripleLiteralString: [
        [/[^']+/, "string"],
        [/'''/, { token: "string.quote", next: "@pop" }],
        [/'/, "string"],
      ],
    },
  };
  monaco.languages.setMonarchTokensProvider(id, tokenizer);

  const config: Monaco.languages.LanguageConfiguration = {
    comments: {
      lineComment: "#",
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" },
    ],
  };
  monaco.languages.setLanguageConfiguration(id, config);
}
