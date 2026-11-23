import { join } from 'node:path';
import type { PromptCommand } from './types.js';

/**
 * Common in-session commands from Claude Code's command reference. Availability
 * can depend on the CLI version, account, and platform. The console merges these
 * with discovered skills; a skill of the same name wins.
 */
export function claudeSlash(): PromptCommand[] {
  return [
    { name: '/help', description: 'Show available commands' },
    { name: '/clear', description: 'Clear the conversation and start fresh' },
    { name: '/compact', description: 'Summarize the conversation to free up context' },
    { name: '/autocompact', description: 'Adjust when Claude automatically compacts context' },
    { name: '/context', description: 'Show what is using the context window' },
    { name: '/resume', description: 'Resume a previous conversation' },
    { name: '/rewind', description: 'Rewind the conversation and code to an earlier point' },
    { name: '/model', description: 'Choose the model and reasoning effort' },
    { name: '/effort', description: 'Change or inspect the reasoning level' },
    { name: '/fast', description: 'Toggle fast mode when available' },
    { name: '/plan', description: 'Enter Plan mode' },
    { name: '/goal', description: 'Set or clear a goal that persists across turns' },
    { name: '/btw', description: 'Ask a question outside the main conversation' },
    { name: '/agents', description: 'View and switch between agent sessions' },
    { name: '/config', description: 'Open the settings' },
    { name: '/permissions', description: 'Choose what Claude is allowed to do' },
    { name: '/add-dir', description: 'Grant access to another working directory' },
    { name: '/sandbox', description: 'Manage the shell command sandbox' },
    { name: '/rename', description: 'Rename the current session' },
    { name: '/fork', description: 'Fork the current conversation' },
    { name: '/branch', description: 'Explore a different direction in a copy of the conversation' },
    { name: '/background', description: 'Detach from the session and keep it running' },
    { name: '/export', description: 'Export the conversation' },
    { name: '/copy', description: 'Copy the last response' },
    { name: '/diff', description: 'Show the git diff' },
    { name: '/init', description: 'Create a CLAUDE.md with instructions for Claude' },
    { name: '/memory', description: 'Edit Claude memory files' },
    { name: '/review', description: 'Review the current changes' },
    { name: '/code-review', description: 'Run a code review for a diff or pull request' },
    { name: '/security-review', description: 'Review branch changes for security issues' },
    { name: '/todo', description: 'Show the current to-do list' },
    { name: '/tasks', description: 'Inspect ongoing and completed background work' },
    { name: '/hooks', description: 'View and manage lifecycle hooks' },
    { name: '/mcp', description: 'Inspect or configure MCP server connections' },
    { name: '/plugin', description: 'Browse and configure Claude Code plugins' },
    { name: '/reload-plugins', description: 'Apply pending plugin changes' },
    { name: '/skills', description: 'Browse skills available to the session' },
    { name: '/reload-skills', description: 'Discover skills that changed on disk' },
    { name: '/status', description: 'Show the session configuration and usage' },
    { name: '/usage', description: 'View account usage and rate limits' },
    { name: '/recap', description: 'Display a short summary of the current session' },
    { name: '/doctor', description: 'Diagnose Claude Code installation and configuration issues' },
    { name: '/output-style', description: 'Browse or select a response style' },
    { name: '/statusline', description: 'Customize the terminal status line' },
    { name: '/keybindings', description: 'Edit custom keyboard shortcuts' },
    { name: '/tui', description: 'Switch between classic and fullscreen rendering' },
    { name: '/vim', description: 'Toggle Vim mode for the composer' },
    { name: '/theme', description: 'Choose a color theme' },
  ];
}

/**
 * Claude loads skills from the account-global directory and the workspace's own
 * `.claude/skills` (docs/skills). The console injects the state directory root; the
 * Adapter only names the paths. A skill is invoked as `/name`.
 */
export function claudeSkillDirectories(workspace: string, stateDirectory: string): string[] {
  return [join(stateDirectory, 'skills'), join(workspace, '.claude', 'skills')];
}
