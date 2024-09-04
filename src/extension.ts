import * as vscode from 'vscode';

enum ids {
	extId = "simple-runner",
	extTitle = "Simple Runner",
	isWeb = extId + "." + "isWeb",
	enableRunButton = extId + "." + "enableRunButton",
	enableMarkdownCodeLens = extId + "." + "enableMarkdownCodeLens",
	runInTerminal = extId + "." + "runInTerminal",
	showDebugInfo = extId + "." + "showDebugInfo",
	showTimestampInDebugInfo = extId + "." + "showTimestampInDebugInfo",
	clearOutputBeforeRun = extId + "." + "clearOutputBeforeRun",
	showOutputBeforeRun = extId + "." + "showOutputBeforeRun",
	languageMap = extId + "." + "languageMap",
	runFile = extId + "." + "runFile",
	stopTask = extId + "." + "stopTask",
	copyCodeBlock = extId + "." + "copyCodeBlock",
	runCodeBlock = extId + "." + "runCodeBlock",
	supportedLanguages = extId + "." + "supportedLanguages",
	fileListInTask = extId + "." + "fileListInTask",
	toggleRunInTerminal = extId + "." + "toggleRunInTerminal",
	toggleShowDebugInfo = extId + "." + "toggleShowDebugInfo",
	toggleClearOutputBeforeRun = extId + "." + "toggleClearOutputBeforeRun",
	markdownCodeLensStyle = extId + "." + "markdownCodeLensStyle",
}

const isWeb: boolean = typeof process === 'undefined'
const outputChannel = vscode.window.createOutputChannel(ids.extTitle, 'log');
const fileTaskMap: Map<string, any> = new Map();

const getConfig: () => any = () => vscode.workspace.getConfiguration();
const getlanguageMap: () => any = () => getConfig().get(ids.languageMap);

// We need to sanitize the path before using vscode.URI.fsPath.
// https://github.com/microsoft/vscode/blob/777f6917e2956882688847460e6f4b10a26f0670/extensions/git/src/git.ts#L353
function sanitizePath(path: string): string {
	return path.replace(/^([a-z]):\\/i, (_, letter) => `${letter.toUpperCase()}:\\`);
}

function getTimeStamp(date: Date) {
	return date.toISOString().replace('T', ' ').replace('Z', '');
}

function debugWrite(msg: string, timeStamp: string = getTimeStamp(new Date()), prefix: string = "") {
	if (getConfig().get(ids.showDebugInfo)) {
		outputChannel.append(prefix + (getConfig().get(ids.showTimestampInDebugInfo) ? getTimeStamp(new Date()) + " " : "") + msg);
	}
}

function getExtTmpDir() {
	return require('path').join(require('os').tmpdir(), ids.extId);
}

function runInTerminal(command: string, context: vscode.ExtensionContext) {
	const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal();

	if (getConfig().get(ids.showOutputBeforeRun)) {
		terminal.show();
	}
	if (getConfig().get(ids.clearOutputBeforeRun)) {
		vscode.commands.executeCommand("workbench.action.terminal.clear");
	}
	terminal.sendText(command);
}

async function runInChildProcess(command: string, file: vscode.Uri): Promise<any> {
	if (getConfig().get(ids.showOutputBeforeRun)) {
		outputChannel?.show(true);
	}
	if (getConfig().get(ids.clearOutputBeforeRun)) {
		outputChannel?.clear();
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: vscode.l10n.t('Running {0}', sanitizePath(file.fsPath)),
		cancellable: true
	}, async (progress, token) => {
		const startTimeFormatted = getTimeStamp(new Date());
		const startTime = process.hrtime();
		const childProcess = require('child_process').spawn(command, {
			shell: true,
			cwd: (() => {
				const fileFolder = vscode.workspace.getWorkspaceFolder(file);
				if (fileFolder) {
					return sanitizePath(fileFolder.uri.fsPath);
				}

				const editorFolder = vscode.window.activeTextEditor
					? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
					: undefined;

				if (editorFolder) {
					return sanitizePath(editorFolder.uri.fsPath);
				}
			})()
		});
		const processMsg = `[PID:${childProcess.pid}]`;
		debugWrite(`[info] ${processMsg} Running: ${command}\n`, startTimeFormatted);
		fileTaskMap.set(file.path, childProcess);
		vscode.commands.executeCommand('setContext', ids.fileListInTask, Array.from(fileTaskMap.keys()));

		childProcess.stdout.on('data', (data: { toString: () => string; }) => {
			progress.report({ message: data.toString() });
			outputChannel?.append(data.toString());
		});

		childProcess.stderr.on('data', (data: { toString: () => string; }) => {
			progress.report({ message: data.toString() });
			outputChannel?.append(data.toString());
		});

		token.onCancellationRequested(() => {
			require('tree-kill')(childProcess.pid, 'SIGKILL');
		});

		await new Promise((resolve, reject) => {
			childProcess.on('close', (code: number | null, signal: any) => {
				const endTime = process.hrtime(startTime);
				const [seconds, nanoseconds] = endTime;
				const elapsedTimeMsg = ` in ${(seconds + nanoseconds / 1e9).toFixed(2)} s`;

				fileTaskMap.delete(file.path);
				vscode.commands.executeCommand('setContext', ids.fileListInTask, Array.from(fileTaskMap.keys()));
				if (signal) {
					const msg = `[error] ${processMsg} Killed by signal: ${signal}${elapsedTimeMsg}\n`;
					debugWrite(msg, undefined, "\n");
					resolve(msg);
				} else if (code === null) {
					const msg = `[error] ${processMsg} Killed by unknown means${elapsedTimeMsg}\n`;
					debugWrite(msg, undefined, "\n");
					resolve(msg);
				} else {
					const msg = `[${code === 0 ? 'info' : 'error'}] ${processMsg} Exited with code: ${code}${elapsedTimeMsg}\n`;
					debugWrite(msg, undefined, "\n");
					resolve(msg);
				}
			});
		});
	});
}

function runFile(file: vscode.Uri, languageId: string, context: vscode.ExtensionContext) {
	if (!fileTaskMap.has(file.path)) {
		const path = require('path');
		const filePath = sanitizePath(file.fsPath);
		const fileBasename = path.basename(filePath);
		const fileBasenameNoExtension = path.basename(file.fsPath, path.extname(file.fsPath));
		const fileExtname = path.extname(filePath);
		const fileDirname = path.dirname(filePath);
		const fileDirnameBasename = path.basename(fileDirname);
		const extTmpDir = getExtTmpDir();

		const command = getlanguageMap()[languageId]
			.replace(/\$\{file\}/g, filePath)
			.replace(/\$\{fileBasename\}/g, fileBasename)
			.replace(/\$\{fileBasenameNoExtension\}/g, fileBasenameNoExtension)
			.replace(/\$\{fileExtname\}/g, fileExtname)
			.replace(/\$\{fileDirname\}/g, fileDirname)
			.replace(/\$\{fileDirnameBasename\}/g, fileDirnameBasename)
			.replace(/\$\{pathSeparator\}/g, path.sep)
			.replace(/\$\{extTmpDir\}/g, extTmpDir);

		if (getConfig().get(ids.runInTerminal)) {
			runInTerminal(command, context);
		} else {
			runInChildProcess(command, file);
		}
	}
}

function copyMarkdownCodeBlock(codeBlock: any) {
	vscode.env.clipboard.writeText(codeBlock.content).then(() => {
		vscode.window.showInformationMessage(vscode.l10n.t('Copied code block to clipboard'))
	}, (error) => {
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy code block: {0}', error));
	});
}

async function runMarkdownCodeBlock(codeBlock: any, context: vscode.ExtensionContext) {
	const path = require('path');
	const fs = require('fs');

	const extTmpDir = getExtTmpDir();
	// Create directory if it doesn't exist
	if (!fs.existsSync(extTmpDir)) {
		try {
			fs.mkdirSync(extTmpDir, { recursive: true });
			debugWrite(`[info] Directory ${extTmpDir} created successfully.\n`);
		} catch (err) {
			debugWrite(`[error] Failed to create directory: ${err}\n`);
			return;
		}
	}

	// Write code block to file
	let filePath = path.join(extTmpDir, require('crypto').createHash('sha256').update(codeBlock.content).digest('hex').substring(0, 8) + codeBlock.fileExtension);
	try {
		fs.writeFileSync(filePath, codeBlock.encodeInUtf16 ? Buffer.concat([Buffer.from('\uFEFF', 'utf16le'), Buffer.from(codeBlock.content, 'utf16le')]) : codeBlock.content);
	} catch (err) {
		debugWrite(` [error] Failed to write to file: ${err}\n`);
		return;
	}

	runFile(vscode.Uri.file(filePath), codeBlock.languageId, context);
}

function getLanguageDetails(codeBlockInfo: string): { languageId: string, fileExtension: string, encodeInUtf16: boolean } {
	let languageId = codeBlockInfo;
	let fileExtension = `.${codeBlockInfo}`;
	let encodeInUtf16 = false;

	switch (codeBlockInfo.toLowerCase()) {
		case 'ahk':
		case 'autohotkey':
			languageId = 'ahk';
			fileExtension = '.ahk';
			break;
		case 'applescript':
			fileExtension = '.scpt';
			break;
		case 'autoit':
			fileExtension = '.au3';
			break;
		case 'bat':
		case 'batch':
			languageId = 'bat';
			fileExtension = '.bat';
			break;
		case 'clojure':
			fileExtension = '.clj';
			break;
		case 'coffeescript':
			fileExtension = '.coffee';
			break;
		case 'cpp':
		case 'c++':
			languageId = 'cpp';
			fileExtension = '.cpp';
			break;
		case 'crystal':
			fileExtension = '.cr';
			break;
		case 'csharp':
		case 'c#':
			languageId = 'csharp';
			fileExtension = '.cs';
			break;
		case 'erlang':
			fileExtension = '.erl';
			break;
		case 'fortran_fixed-form':
		case 'fortran_modern':
		case 'fortran':
		case 'FortranFreeForm':
			languageId = 'fortran';
			fileExtension = codeBlockInfo === 'fortran' ? '.f' : '.f90';
			break;
		case 'fsharp':
		case 'f#':
			languageId = 'fsharp';
			fileExtension = '.fs';
			break;
		case 'gleam':
			fileExtension = '.gl';
			break;
		case 'go':
		case 'golang':
			languageId = 'go';
			fileExtension = '.go';
			break;
		case 'haskell':
			fileExtension = '.hs';
			break;
		case 'haxe':
			fileExtension = '.hx';
			break;
		case 'javascript':
		case 'js':
			languageId = 'javascript';
			fileExtension = '.js';
			break;
		case 'julia':
			fileExtension = '.jl';
			break;
		case 'objective-c':
		case 'objective':
		case 'objc':
			languageId = 'objective-c';
			fileExtension = '.m';
			break;
		case 'ocaml':
			fileExtension = '.ml';
			break;
		case 'pascal':
			fileExtension = '.pas';
			break;
		case 'perl':
			fileExtension = '.pl';
			break;
		case 'perl6':
			fileExtension = '.pm';
			break;
		case 'powershell':
			fileExtension = '.ps1';
			encodeInUtf16 = true;
			break;
		case 'python':
		case 'py':
			languageId = 'python';
			fileExtension = '.py';
			break;
		case 'racket':
			fileExtension = '.rkt';
			break;
		case 'ruby':
			fileExtension = '.rb';
			break;
		case 'rust':
		case 'rs':
			languageId = 'rust';
			fileExtension = '.rs';
			break;
		case 'scheme':
			fileExtension = '.scm';
			break;
		case 'shellscript':
		case 'bash':
		case 'sh':
		case 'shell':
			languageId = 'shellscript';
			fileExtension = '.sh';
			break;
		case 'typescript':
		case 'ts':
			languageId = 'typescript';
			fileExtension = '.ts';
			break;
		case 'vb':
		case 'vbscript':
		case 'vbs':
			languageId = 'vb';
			fileExtension = '.vbs';
			encodeInUtf16 = true;
			break;
		default:
			languageId = codeBlockInfo;
			fileExtension = `.${codeBlockInfo}`;
			break;
	}

	return { languageId, fileExtension, encodeInUtf16 };
}

function getCodeLensCommandTitle(command: string): string {
	switch (getConfig().get(ids.markdownCodeLensStyle)) {
		case "icon":
			return command === ids.copyCodeBlock ? '$(copy)' : '$(run)';
		case "text":
			return command === ids.copyCodeBlock ? vscode.l10n.t('Copy') : vscode.l10n.t('Run');
		default:
			return command === ids.copyCodeBlock ? '$(copy)' + vscode.l10n.t('Copy') : '$(run)' + vscode.l10n.t('Run');
	}
}

// Define a function to provide codelens for each code block
function provideMarkdownCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
	const codeLenses: vscode.CodeLens[] = [];
	if (getConfig().get(ids.enableMarkdownCodeLens)) {
		const codeBlockRegex = /^([ \t]*)(`{3,})(.+)\n([\s\S]*?)\n\1\2$/gm;
		let match;

		while ((match = codeBlockRegex.exec(document.getText())) !== null) {
			const indentation = match[1];
			const codeBlockInfo = match[3] || '';

			// Check if all lines in match[3] have the same indentation
			const lines = match[4].split('\n');
			if (!lines.every(line => line.startsWith(indentation) || line.trim() === '')) {
				continue; // Skip this code block if not all lines have the same indentation
			}

			// Extract code block content and remove the common indentation
			const codeBlockContent = lines.map(line => line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n');
			const codeBlockStart = document.positionAt(match.index);

			const { languageId, fileExtension, encodeInUtf16 } = getLanguageDetails(codeBlockInfo);

			const codeBlock = {
				info: codeBlockInfo,
				content: codeBlockContent,
				languageId,
				fileExtension,
				encodeInUtf16
			};

			codeLenses.push(new vscode.CodeLens(new vscode.Range(codeBlockStart, codeBlockStart), {
				command: ids.copyCodeBlock,
				title: getCodeLensCommandTitle(ids.copyCodeBlock),
				tooltip: vscode.l10n.t('Copy code block'),
				arguments: [codeBlock]
			}));

			const runner = getlanguageMap()[languageId];
			if (!isWeb && runner) {
				codeLenses.push(new vscode.CodeLens(new vscode.Range(codeBlockStart, codeBlockStart), {
					command: ids.runCodeBlock,
					title: getCodeLensCommandTitle(ids.runCodeBlock),
					tooltip: vscode.l10n.t('Run code block{0}', `\n${runner}`),
					arguments: [codeBlock]
				}));
			}
		}
	}
	return codeLenses;
}

function initMarkdownCodeLens(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: '*', language: 'markdown' }, {
		provideCodeLenses: (document: vscode.TextDocument, token: vscode.CancellationToken) => {
			return provideMarkdownCodeLenses(document);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand(ids.copyCodeBlock, (codeBlock) => {
		copyMarkdownCodeBlock(codeBlock);
	}));

	if (!isWeb) {
		context.subscriptions.push(vscode.commands.registerCommand(ids.runCodeBlock, (codeBlock) => {
			runMarkdownCodeBlock(codeBlock, context);
		}));
	}
}

function initRunButton(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand('setContext', ids.enableRunButton, getConfig().get(ids.enableRunButton));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(ids.enableRunButton)) {
			vscode.commands.executeCommand('setContext', ids.enableRunButton, getConfig().get(ids.enableRunButton));
		}
	}));

	vscode.commands.executeCommand('setContext', ids.supportedLanguages, Object.keys(getlanguageMap()).filter(k => getlanguageMap()[k]));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(ids.languageMap)) {
			vscode.commands.executeCommand('setContext', ids.supportedLanguages, Object.keys(getlanguageMap()).filter(k => getlanguageMap()[k]));
		}
	}));
}

export function activate(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand('setContext', ids.isWeb, isWeb);
	debugWrite(`[info] isWeb: ${isWeb}\n`);

	initMarkdownCodeLens(context);
	if (!isWeb) {
		initRunButton(context);

		context.subscriptions.push(vscode.commands.registerCommand(ids.runFile, (file) => {
			const document = file ? vscode.workspace.textDocuments.find(d => d.uri.path === file.path) : vscode.window.activeTextEditor?.document;
			if (document) {
				runFile(document.uri, document.languageId, context);
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand(ids.stopTask, (file) => {
			const filePath = file ? file.path : vscode.window.activeTextEditor?.document.uri.path;
			if (filePath && fileTaskMap.has(filePath)) {
				require('tree-kill')(fileTaskMap.get(filePath).pid, 'SIGKILL');
			}
		}));

		const toggleMap = new Map();
		toggleMap.set(ids.toggleRunInTerminal, ids.runInTerminal);
		toggleMap.set(ids.toggleShowDebugInfo, ids.showDebugInfo);
		toggleMap.set(ids.toggleClearOutputBeforeRun, ids.clearOutputBeforeRun);

		toggleMap.forEach((value, key) => {
			context.subscriptions.push(vscode.commands.registerCommand(key, (file) => {
				vscode.workspace.getConfiguration().update(value, !getConfig().get(value), vscode.ConfigurationTarget.Global);
			}));
		});
	}
}

export async function deactivate() { }

