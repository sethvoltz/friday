import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { checkBashForDisaster } from "./disaster-patterns.js";

const WORKSPACE = "/tmp/test-workspace";
const HOME = homedir();

interface Case {
  command: string;
  expected: "allow" | "deny";
  reasonMatch?: RegExp;
}

const cases: Case[] = [
  // Rule 2: rm -r outside worktree
  { command: "rm -rf ~", expected: "deny", reasonMatch: /rm -r blocked/ },
  { command: "rm -rf $HOME/foo", expected: "deny", reasonMatch: /rm -r blocked/ },
  { command: 'rm -rf "$HOME/foo"', expected: "deny", reasonMatch: /rm -r blocked/ },
  { command: "rm -rf /", expected: "deny", reasonMatch: /rm -r blocked/ },
  { command: 'rm -rf "$UNSET_VAR/"', expected: "deny", reasonMatch: /rm -r blocked/ },
  { command: "rm -r /etc", expected: "deny", reasonMatch: /rm -r blocked/ },
  { command: "rm -Rf /Users/seth/Downloads", expected: "deny", reasonMatch: /rm -r blocked/ },
  { command: "rm --recursive /var/log", expected: "deny", reasonMatch: /rm -r blocked/ },

  // Rule 2 allow cases
  { command: "rm -rf node_modules", expected: "allow" },
  { command: "rm -rf .next", expected: "allow" },
  { command: "rm -rf dist build", expected: "allow" },
  { command: "rm -rf /tmp/test-workspace/node_modules", expected: "allow" },
  { command: "rm file.txt", expected: "allow" }, // non-recursive

  // Rule 3: find -delete / -exec rm
  {
    command: "find / -name passwd -delete",
    expected: "deny",
    reasonMatch: /find.*blocked/,
  },
  {
    command: "find ~ -name '*.log' -delete",
    expected: "deny",
    reasonMatch: /find.*blocked/,
  },
  {
    command: "find /etc -name foo -exec rm {} +",
    expected: "deny",
    reasonMatch: /find.*blocked/,
  },
  { command: "find . -name '*.log' -delete", expected: "allow" },
  { command: "find . -type f -name '*.tmp' -print", expected: "allow" },

  // Rule 4: redirections to credentials / dotfiles / persistence
  {
    command: "echo foo > ~/.zshrc",
    expected: "deny",
    reasonMatch: /redirection target.*protected/,
  },
  {
    command: "echo foo >> ~/.bashrc",
    expected: "deny",
    reasonMatch: /redirection target.*protected/,
  },
  {
    command: "cat /dev/null > ~/.aws/credentials",
    expected: "deny",
    reasonMatch: /redirection target.*protected/,
  },
  {
    command: "echo plist > ~/Library/LaunchAgents/com.evil.plist",
    expected: "deny",
    reasonMatch: /redirection target.*protected/,
  },
  {
    command: "tee -a ~/.ssh/config < /dev/null",
    expected: "deny",
    reasonMatch: /tee blocked/,
  },
  { command: "echo hi > config.json", expected: "allow" },
  { command: "echo hi >> /tmp/test-workspace/out.log", expected: "allow" },

  // Rule 4: cp / mv to denied paths
  {
    command: "cp creds.txt ~/.aws/credentials",
    expected: "deny",
    reasonMatch: /cp blocked/,
  },
  {
    command: "mv evil.plist ~/Library/LaunchAgents/",
    expected: "deny",
    reasonMatch: /mv blocked/,
  },
  { command: "cp file.txt other.txt", expected: "allow" },

  // Rule 5: binary deny-list
  { command: "launchctl load -w foo.plist", expected: "deny", reasonMatch: /launchctl.*deny list/ },
  { command: "crontab -e", expected: "deny", reasonMatch: /crontab.*deny list/ },
  { command: "sudo whoami", expected: "deny", reasonMatch: /sudo.*deny list/ },
  { command: 'osascript -e "do shell script"', expected: "deny", reasonMatch: /osascript.*deny list/ },
  { command: "su admin", expected: "deny", reasonMatch: /su.*deny list/ },
  { command: "tccutil reset All", expected: "deny", reasonMatch: /tccutil.*deny list/ },

  // Rule 6: git subcommands
  {
    command: "git push --force origin main",
    expected: "deny",
    reasonMatch: /force-push to "main"/,
  },
  {
    command: "git push -f origin master",
    expected: "deny",
    reasonMatch: /force-push to "master"/,
  },
  {
    command: "git push --force-with-lease origin main",
    expected: "deny",
    reasonMatch: /force-push to "main"/,
  },
  {
    command: "git push origin :main",
    expected: "deny",
    reasonMatch: /delete remote branch "main"/,
  },
  {
    command: "git push origin :refs/heads/main",
    expected: "deny",
    reasonMatch: /delete remote branch "main"/,
  },
  {
    command: "git filter-branch --prune-empty HEAD",
    expected: "deny",
    reasonMatch: /filter-branch.*irrevocable/,
  },
  { command: "git gc --aggressive", expected: "deny", reasonMatch: /gc --aggressive/ },
  {
    command: "git reflog expire --expire=now --all",
    expected: "deny",
    reasonMatch: /reflog expire/,
  },
  { command: "git update-ref -d refs/heads/foo", expected: "deny", reasonMatch: /update-ref -d/ },
  {
    command: "git worktree remove /some/path",
    expected: "deny",
    reasonMatch: /worktree remove/,
  },

  // Rule 6 allow cases
  { command: "git push origin friday/builder-foo", expected: "allow" },
  { command: "git push origin HEAD:friday/builder-foo", expected: "allow" },
  { command: "git push --force origin friday/builder-foo", expected: "allow" },
  { command: "git push", expected: "allow" },
  { command: "git commit -m 'feat: x'", expected: "allow" },
  { command: "git log --oneline", expected: "allow" },
  { command: "git status", expected: "allow" },

  // Rule 7: package managers
  // pnpm v9+ has its own opt-in via pnpm.onlyBuiltDependencies, so plain
  // `pnpm install` / `pnpm add` are allowed. npm + classic yarn run all
  // postinstalls by default and still require --ignore-scripts.
  { command: "pnpm install", expected: "allow" },
  { command: "pnpm install --prod", expected: "allow" },
  { command: "pnpm add lodash", expected: "allow" },
  { command: "pnpm i", expected: "allow" },
  { command: "pnpm install --ignore-scripts", expected: "allow" },
  { command: "npm install", expected: "deny", reasonMatch: /--ignore-scripts/ },
  { command: "npm i react", expected: "deny", reasonMatch: /--ignore-scripts/ },
  { command: "yarn", expected: "deny", reasonMatch: /--ignore-scripts/ },
  { command: "yarn add chalk", expected: "deny", reasonMatch: /--ignore-scripts/ },
  { command: "npm install --ignore-scripts=true", expected: "allow" },
  { command: "yarn add chalk --ignore-scripts", expected: "allow" },
  { command: "pnpm test", expected: "allow" },
  { command: "pnpm run build", expected: "allow" },

  // Rule 8: workspace marker
  { command: "rm .friday-workspace.json", expected: "deny", reasonMatch: /worker identity marker/ },
  { command: "rm ./.friday-workspace.json", expected: "deny", reasonMatch: /worker identity marker/ },

  // Rule 9: command substitution in catastrophe positions
  {
    command: "rm -rf $(echo /etc)",
    expected: "deny",
    reasonMatch: /command substitution/,
  },
  {
    command: "cp file $(find / -name passwd)",
    expected: "deny",
    reasonMatch: /cp blocked.*command substitution/,
  },
  {
    command: "$(which rm) -rf foo",
    expected: "deny",
    reasonMatch: /command itself is a command substitution/,
  },

  // Pipelines / sequences: every clause is checked.
  {
    command: "echo hi && rm -rf ~",
    expected: "deny",
    reasonMatch: /rm -r blocked/,
  },
  {
    command: "ls | grep foo && launchctl load -w x.plist",
    expected: "deny",
    reasonMatch: /launchctl/,
  },
  { command: "ls && pwd && date", expected: "allow" },

  // Sanity: empty / whitespace
  { command: "", expected: "allow" },
  { command: "   ", expected: "allow" },
];

describe("disaster-patterns / checkBashForDisaster", () => {
  for (const c of cases) {
    const label = `${c.expected === "deny" ? "denies" : "allows"}: ${c.command || "<empty>"}`;
    it(label, () => {
      const result = checkBashForDisaster(c.command, WORKSPACE);
      if (c.expected === "allow") {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        if (c.reasonMatch) expect(result).toMatch(c.reasonMatch);
      }
    });
  }

  // Spot-check that the tilde expansion uses the worker's actual HOME.
  it("expands ~ to the worker's HOME for containment", () => {
    const r = checkBashForDisaster(`rm -rf ${HOME}/Downloads`, WORKSPACE);
    expect(r).not.toBeNull();
    expect(r).toMatch(/rm -r blocked/);
  });

  // Robustness: malformed shell shouldn't crash. shell-quote is lenient
  // (an unterminated quote becomes a single literal token), but the
  // disaster check should still run without throwing.
  it("does not throw on malformed input", () => {
    expect(() =>
      checkBashForDisaster("rm -rf 'unterminated", WORKSPACE),
    ).not.toThrow();
  });
});
