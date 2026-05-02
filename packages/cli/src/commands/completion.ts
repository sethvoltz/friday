import { defineCommand } from "citty";
import { COMPLETION_MANIFEST } from "../branding.js";

function zshScript(): string {
  // Static zsh completion. Generated from COMPLETION_MANIFEST so we never
  // walk the citty subCommand tree at Tab time (that would trigger lazy
  // imports of @friday/evolve and slow every keystroke).
  const topLevel = COMPLETION_MANIFEST.map((c) => c.name).join(" ");
  const subCases = COMPLETION_MANIFEST
    .filter((c) => c.subs && c.subs.length > 0)
    .map((c) => `      ${c.name}) _values 'subcommand' ${(c.subs ?? []).map((s) => `'${s}'`).join(" ")} ;;`)
    .join("\n");

  return `#compdef friday
# Friday CLI completions for zsh.
# Install: place this file (named _friday) in a directory on $fpath, e.g.
#   mkdir -p ~/.zsh/completions
#   friday completion zsh > ~/.zsh/completions/_friday
#   echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
#   echo 'autoload -Uz compinit && compinit' >> ~/.zshrc

_friday() {
  local -a commands
  commands=(${COMPLETION_MANIFEST.map((c) => `'${c.name}'`).join(" ")})

  if (( CURRENT == 2 )); then
    _values 'command' \\
      ${topLevel.split(" ").map((n) => `'${n}'`).join(" \\\n      ")}
    return
  fi

  case "\${words[2]}" in
${subCases}
  esac
}

_friday "$@"
`;
}

function bashScript(): string {
  const topLevel = COMPLETION_MANIFEST.map((c) => c.name).join(" ");
  const subCases = COMPLETION_MANIFEST
    .filter((c) => c.subs && c.subs.length > 0)
    .map((c) => `    ${c.name}) COMPREPLY=( $(compgen -W "${(c.subs ?? []).join(" ")}" -- "$cur") ) ;;`)
    .join("\n");

  return `# Friday CLI completions for bash.
# Install:
#   friday completion bash > ~/.local/share/bash-completion/completions/friday
# or source it from your bashrc:
#   echo 'source <(friday completion bash)' >> ~/.bashrc

_friday() {
  local cur prev words cword
  _init_completion || return

  if [[ \$cword -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "${topLevel}" -- "\$cur") )
    return
  fi

  case "\${words[1]}" in
${subCases}
  esac
}

complete -F _friday friday
`;
}

export const completionCommandCitty = defineCommand({
  meta: {
    name: "completion",
    description: "Print a shell completion script. Subcommands: zsh, bash.",
  },
  subCommands: {
    zsh: defineCommand({
      meta: { name: "zsh", description: "Print a zsh completion script for friday." },
      run() {
        process.stdout.write(zshScript());
      },
    }),
    bash: defineCommand({
      meta: { name: "bash", description: "Print a bash completion script for friday." },
      run() {
        process.stdout.write(bashScript());
      },
    }),
  },
});
