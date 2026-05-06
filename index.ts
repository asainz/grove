#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

type CleanupMode = "ask" | "keep" | "delete";

type SessionOptions = {
	cleanup: CleanupMode;
	codexArgs: string[];
	workboxArgs: string[];
};

type WorkboxStatusOutput = {
	ok: boolean;
	data?: Array<{
		name?: string;
		path?: string;
		managed?: boolean;
		managedBranch?: string;
	}>;
};

type RemovalPlan = {
	workboxArgs: string[];
	manualBranchDelete?: string;
};

const WORKBOX_INSTALL_HINT =
	"Install Workbox with `bun add -g @alecrust/workbox` or install Grove dependencies with `bun install`.";
const DELETE_BRANCH_FLAG = "--delete-branch";
const KEEP_BRANCH_FLAG = "--keep-branch";

const [, , rawCommand, ...rawArgs] = Bun.argv;
const command = rawCommand ?? "help";

const commands: Record<string, (args: string[]) => Promise<void> | void> = {
	help: printHelp,
	"-h": printHelp,
	"--help": printHelp,
	new: createSession,
	start: createSession,
	resume: resumeSession,
	enter: enterSession,
	list: listSessions,
	ls: listSessions,
	status: showStatus,
	rm: removeSession,
	remove: removeSession,
	prune: pruneSessions,
};

await (commands[command] ?? createSession)(
	commands[command] ? rawArgs : [command, ...rawArgs],
);

async function createSession(args: string[]) {
	ensureSessionDependencies();
	const { name, rest } = readName(
		args,
		"Usage: grove new <name> [--from <ref>] [-- <codex args...>]",
	);
	const options = parseSessionOptions(rest);

	runOrExit(
		workboxCommand(),
		["new", name, ...options.workboxArgs],
		"`wkb new` failed",
	);
	const exitCode = runCodex(name, options.codexArgs);
	await cleanupSession(name, options.cleanup);
	exitWithStatus(exitCode);
}

async function resumeSession(args: string[]) {
	ensureSessionDependencies();
	const { name, rest } = readName(
		args,
		"Usage: grove resume <name> [--last] [-- <prompt>]",
	);
	const options = parseSessionOptions(rest);
	const resumeArgs = stripOptionalSeparator(
		options.codexArgs.length > 0 ? options.codexArgs : options.workboxArgs,
	);

	const exitCode = runCodex(name, ["resume", ...resumeArgs]);
	await cleanupSession(name, options.cleanup);
	exitWithStatus(exitCode);
}

async function enterSession(args: string[]) {
	ensureSessionDependencies();
	const { name, rest } = readName(
		args,
		"Usage: grove enter <name> [-- <codex args...>]",
	);
	const options = parseSessionOptions(rest);

	const exitCode = runCodex(
		name,
		stripOptionalSeparator(
			options.codexArgs.length > 0 ? options.codexArgs : options.workboxArgs,
		),
	);
	await cleanupSession(name, options.cleanup);
	exitWithStatus(exitCode);
}

function listSessions() {
	ensureWorkbox();
	runOrExit(workboxCommand(), ["list"], "`wkb list` failed");
}

function showStatus(args: string[]) {
	ensureWorkbox();
	runOrExit(workboxCommand(), ["status", ...args], "`wkb status` failed");
}

function removeSession(args: string[]) {
	ensureWorkbox();
	const { name, rest } = readName(
		args,
		"Usage: grove rm <name> [--force] [--unmanaged] [--keep-branch]",
	);
	runRemovalPlan(name, rest, "`wkb rm` failed");
}

function pruneSessions() {
	ensureWorkbox();
	runOrExit(workboxCommand(), ["prune"], "`wkb prune` failed");
}

function runCodex(name: string, codexArgs: string[]) {
	const result = spawnSync("codex", codexArgs, {
		cwd: resolveWorktreePath(name),
		stdio: "inherit",
	});

	if (result.error)
		exitWithError(
			`Failed to run codex in worktree '${name}': ${result.error.message}`,
		);
	if (typeof result.status === "number") return result.status;
	return 1;
}

async function cleanupSession(name: string, mode: CleanupMode) {
	if (mode === "keep") return;

	let shouldDelete = mode === "delete";
	if (mode === "ask") {
		shouldDelete = await confirm(`\nDelete worktree '${name}'?`, false);
	}

	if (!shouldDelete) {
		console.log(
			`Keeping worktree '${name}'. Resume with: grove resume ${name}`,
		);
		return;
	}

	runRemovalPlan(
		name,
		[],
		"`wkb rm` failed. If the worktree is dirty, inspect it or run `grove rm <name> --force`.",
	);
}

function runRemovalPlan(name: string, args: string[], failureMessage: string) {
	const plan = planRemoval(name, args);
	runOrExit(workboxCommand(), plan.workboxArgs, failureMessage);

	if (plan.manualBranchDelete) {
		runOrExit(
			"git",
			["branch", "-d", plan.manualBranchDelete],
			`Removed worktree '${name}', but failed to delete branch '${plan.manualBranchDelete}'`,
		);
	}
}

function planRemoval(name: string, args: string[]): RemovalPlan {
	const forwarded = args.filter((arg) => arg !== KEEP_BRANCH_FLAG);
	const keepsBranch = args.includes(KEEP_BRANCH_FLAG);
	const handlesUnmanaged = args.includes("--unmanaged");
	const deletesBranch = args.includes(DELETE_BRANCH_FLAG);
	const userForced = args.includes("--force");

	if (!keepsBranch && !handlesUnmanaged && !deletesBranch) {
		forwarded.push(DELETE_BRANCH_FLAG);
	}

	if (userForced) return { workboxArgs: ["rm", name, ...forwarded] };

	const worktree = resolveWorktree(name);
	if (!worktreeHasSubmodules(worktree.path)) {
		return { workboxArgs: ["rm", name, ...forwarded] };
	}

	if (worktreeIsDirty(worktree.path)) {
		exitWithError(
			`Worktree '${name}' contains submodules and has uncommitted changes. Inspect it or run \`grove rm ${name} --force\` to discard changes and remove it.`,
		);
	}

	console.warn(
		`Worktree '${name}' contains submodules; using \`git worktree remove --force\` after confirming it is clean.`,
	);

	const shouldDeleteBranch =
		!keepsBranch &&
		!handlesUnmanaged &&
		(deletesBranch || forwarded.includes(DELETE_BRANCH_FLAG));

	if (shouldDeleteBranch && worktree.managedBranch) {
		return {
			workboxArgs: [
				"rm",
				name,
				...forwarded.filter((arg) => arg !== DELETE_BRANCH_FLAG),
				"--force",
			],
			manualBranchDelete: worktree.managedBranch,
		};
	}

	return { workboxArgs: ["rm", name, ...forwarded, "--force"] };
}

function parseSessionOptions(args: string[]): SessionOptions {
	const separatorIndex = args.indexOf("--");
	const beforeSeparator =
		separatorIndex === -1 ? args : args.slice(0, separatorIndex);
	const codexArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
	const workboxArgs: string[] = [];
	let cleanup: CleanupMode = "ask";

	for (const arg of beforeSeparator) {
		if (arg === "--keep" || arg === "-k") {
			cleanup = "keep";
		} else if (arg === "--delete" || arg === "-d") {
			cleanup = "delete";
		} else if (arg === "--no-cleanup") {
			cleanup = "keep";
		} else {
			workboxArgs.push(arg);
		}
	}

	return { cleanup, codexArgs, workboxArgs };
}

function stripOptionalSeparator(args: string[]) {
	return args[0] === "--" ? args.slice(1) : args;
}

function readName(args: string[], usage: string) {
	const [name, ...rest] = args;
	if (!name) exitWithError(usage);
	return { name, rest };
}

async function confirm(question: string, defaultValue: boolean) {
	if (!process.stdin.isTTY) return defaultValue;

	const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	try {
		const answer = (await rl.question(question + suffix)).trim().toLowerCase();
		if (answer === "") return defaultValue;
		return (
			answer === "y" ||
			answer === "yes" ||
			answer === "d" ||
			answer === "delete"
		);
	} finally {
		rl.close();
	}
}

function ensureSessionDependencies() {
	ensureExecutable("codex", "Grove requires the Codex CLI on PATH.");
	ensureWorkbox();
}

function ensureWorkbox() {
	if (findExecutable(workboxCommand())) return;
	exitWithError(
		`Grove requires Workbox's \`wkb\` command. ${WORKBOX_INSTALL_HINT}`,
	);
}

function ensureExecutable(binary: string, message: string) {
	if (findExecutable(binary)) return;
	exitWithError(message);
}

function workboxCommand() {
	if (process.env.GROVE_WKB_COMMAND) return process.env.GROVE_WKB_COMMAND;

	const localBinary = join(
		dirname(fileURLToPath(import.meta.url)),
		"node_modules",
		".bin",
		"wkb",
	);
	return existsSync(localBinary) ? localBinary : "wkb";
}

function findExecutable(binary: string) {
	const result = spawnSync(binary, ["--help"], { stdio: "ignore" });
	return result.status === 0;
}

function runOrExit(binary: string, args: string[], failureMessage: string) {
	const result = spawnSync(binary, args, { stdio: "inherit" });
	if (result.error) exitWithError(`${failureMessage}: ${result.error.message}`);
	if (typeof result.status === "number" && result.status !== 0)
		exitWithError(failureMessage);
}

function resolveWorktreePath(name: string) {
	return resolveWorktree(name).path;
}

function resolveWorktree(name: string) {
	const result = spawnSync(workboxCommand(), ["status", name, "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error) {
		exitWithError(
			`Failed to locate worktree '${name}': ${result.error.message}`,
		);
	}

	if (typeof result.status === "number" && result.status !== 0) {
		const stderr = result.stderr.trim();
		exitWithError(
			stderr.length > 0 ? stderr : `Failed to locate worktree '${name}'.`,
		);
	}

	let output: WorkboxStatusOutput;
	try {
		output = JSON.parse(result.stdout) as WorkboxStatusOutput;
	} catch {
		exitWithError(`Failed to parse Workbox status for '${name}'.`);
	}

	const worktree = output.data?.find((item) => item.name === name);
	if (!worktree?.path) {
		exitWithError(`Worktree '${name}' was not found.`);
	}

	return worktree;
}

function worktreeHasSubmodules(path: string) {
	const result = spawnSync(
		"git",
		["-C", path, "config", "--file", ".gitmodules", "--get-regexp", "path"],
		{ stdio: "ignore" },
	);
	return result.status === 0;
}

function worktreeIsDirty(path: string) {
	const result = spawnSync(
		"git",
		["-C", path, "status", "--porcelain=v1", "--ignore-submodules=none"],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	if (result.error) {
		exitWithError(`Failed to inspect worktree status: ${result.error.message}`);
	}

	if (typeof result.status === "number" && result.status !== 0) {
		const stderr = result.stderr.trim();
		exitWithError(
			stderr.length > 0 ? stderr : "Failed to inspect worktree status.",
		);
	}

	return result.stdout.trim().length > 0;
}

function printHelp() {
	console.log(helpText());
}

function helpText() {
	const script = resolve(fileURLToPath(import.meta.url));
	return `grove - Codex sessions in Workbox git worktrees

Usage:
  grove <name> [--from <ref>] [-- <codex args...>]
  grove new <name> [--from <ref>] [-- <codex args...>]
  grove resume <name> [codex resume args...]
  grove enter <name> [-- <codex args...>]
  grove list
  grove status [name]
  grove rm <name> [--force] [--unmanaged] [--keep-branch]
  grove prune

Session options:
  --keep, -k       Keep the worktree without prompting after Codex exits
  --delete, -d     Delete the worktree after Codex exits
  --no-cleanup     Alias for --keep
  --keep-branch    Keep the branch when using grove rm

Examples:
  grove auth-refresh
  grove new auth-refresh --from main
  grove new auth-refresh --from main -- "fix the login redirect"
  grove resume auth-refresh --last
  grove enter auth-refresh -- -m gpt-5.4

This file can be run directly with:
  bun ${script}`;
}

function exitWithError(message: string): never {
	console.error(message);
	process.exit(1);
}

function exitWithStatus(status: number): never {
	process.exit(status);
}
