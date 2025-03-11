import * as vscode from 'vscode';

interface ICodeBlockStart {
	indentation: string
	fence: string;
	langId: string;
}

interface IRawNotebookCell {
	leadingWhitespace: string;
	indentation?: string;
	fence?: string;
	language: string;
	content: string;
	trailingWhitespace: string;
	kind: vscode.NotebookCellKind;
	range: vscode.Range;
}

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
	languageRunnerMap = extId + "." + "languageRunnerMap",
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

const languageDetailsMap = new Map([
	["ahk", { extname: '.ahk', alias: ['autohotkey'] }],
	["bat", { extname: '.bat', alias: ['batch'] }],
	["cpp", { extname: '.cpp', alias: ['c++'] }],
	["csharp", { extname: '.cs', alias: ['c#'] }],
	["fortran", { extname: '.f', alias: ['fortran_fixed-form', 'fortran_modern', 'FortranFreeForm'] }],
	["fsharp", { extname: '.fs', alias: ['f#'] }],
	["go", { extname: '.go', alias: ['golang'] }],
	["javascript", { extname: '.js', alias: ['js'] }],
	["objective-c", { extname: '.m', alias: ['objective', 'objc'] }],
	["python", { extname: '.py', alias: ['py', 'py2', 'py3'] }],
	["rust", { extname: '.rs', alias: ['rs'] }],
	["shellscript", { extname: '.sh', alias: ['sh', 'shell', 'bash'] }],
	["typescript", { extname: '.ts', alias: ['ts'] }],
	["vb", { extname: '.vbs', alias: ['vbscript', 'vbs'] }],
]);

function getConfig(): any {
	return vscode.workspace.getConfiguration();
}

function getlanguageRunnerMap(): any {
	return getConfig().get(ids.languageRunnerMap);
}

function getTimeStamp(date: Date) {
	return date.toISOString().replace('T', ' ').replace('Z', '');
}

function debugWrite(msg: string, timeStamp: string = getTimeStamp(new Date()), prefix: string = "") {
	if (getConfig().get(ids.showDebugInfo)) {
		outputChannel.append(prefix + (getConfig().get(ids.showTimestampInDebugInfo) ? getTimeStamp(new Date()) + " " : "") + msg);
	}
}

function getVscLangId(mdLangId: string): string {
	for (const [vscLangId, data] of languageDetailsMap.entries()) {
		if (data.alias.includes(mdLangId)) {
			return vscLangId;
		}
	}
	return mdLangId;
}

class Runner {
	static terminal: vscode.Terminal | undefined;

	// We need to sanitize the path before using vscode.URI.fsPath.
	// https://github.com/microsoft/vscode/blob/777f6917e2956882688847460e6f4b10a26f0670/extensions/git/src/git.ts#L353
	static sanitizePath(path: string): string {
		return path.replace(/^([a-z]):\\/i, (_, letter) => `${letter.toUpperCase()}:\\`);
	}

	private static getExtTmpDir() {
		return require('path').join(require('os').tmpdir(), 'vscode-' + ids.extId);
	}

	private static runInTerminal(command: string, execution?: vscode.NotebookCellExecution | undefined) {
		if (!this.terminal || this.terminal.exitStatus) {
			this.terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal();
		}

		if (getConfig().get(ids.showOutputBeforeRun)) {
			this.terminal.show();
		}
		if (getConfig().get(ids.clearOutputBeforeRun)) {
			vscode.commands.executeCommand("workbench.action.terminal.clear");
		}
		execution?.start();
		execution?.clearOutput();
		this.terminal.sendText(command);
		execution?.end(true)
	}

	static async runWithChildProcess(command: string, file: vscode.Uri, execution?: vscode.NotebookCellExecution | undefined): Promise<any> {
		if (!fileTaskMap.has(file.path)) {
			const output = {
				stdout: '',
				stderr: '',
			}

			if (getConfig().get(ids.showOutputBeforeRun) && !execution) {
				outputChannel?.show(true);
			}
			if (getConfig().get(ids.clearOutputBeforeRun)) {
				outputChannel?.clear();
			}

			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				// title: vscode.l10n.t('Running {0}', sanitizePath(file.fsPath)),
				title: this.sanitizePath(file.fsPath),
				cancellable: true
			}, async (progress, token) => {
				const cwd = (() => {
					const workspaceFolder =
						(vscode.workspace.workspaceFolders?.length === 1 && vscode.workspace.workspaceFolders[0]) ||
						vscode.workspace.getWorkspaceFolder(file) ||
						(vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)) ||
						(vscode.window.activeNotebookEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeNotebookEditor.notebook.uri));

					return workspaceFolder ? this.sanitizePath(workspaceFolder.uri.fsPath) : undefined;
				})();

				const startTime = Date.now();
				const childProcess = require('child_process').spawn(command, {
					shell: true,
					cwd
				});
				execution?.start(startTime);
				execution?.clearOutput();
				const processMsg = `[PID:${childProcess.pid}]`;
				debugWrite(`[info] ${processMsg} Running: ${command}\n`, getTimeStamp(new Date(startTime)));
				fileTaskMap.set(file.path, childProcess);
				vscode.commands.executeCommand('setContext', ids.fileListInTask, Array.from(fileTaskMap.keys()));

				const cellOutput = new vscode.NotebookCellOutput([]);
				// execution?.appendOutput(cellOutput);
				execution?.replaceOutput(cellOutput);

				childProcess.stdout.on('data', (data: { toString: () => string; }) => {
					output.stdout = output.stdout + data.toString();
					if (!execution) {
						outputChannel?.append(data.toString());
					}
					execution?.replaceOutputItems([
						// vscode.NotebookCellOutputItem.stdout(output.stdout),
						// vscode.NotebookCellOutputItem.error(new Error(output.stderr)),
						vscode.NotebookCellOutputItem.text(output.stdout + output.stderr)
					], cellOutput);
					progress.report({ message: `${data}` });
				});

				childProcess.stderr.on('data', (data: { toString: () => string; }) => {
					output.stderr = output.stderr + data.toString();
					if (!execution) {
						outputChannel?.append(data.toString());
					}
					execution?.replaceOutputItems([
						// vscode.NotebookCellOutputItem.stdout(output.stdout),
						// vscode.NotebookCellOutputItem.error(new Error(output.stderr)),
						vscode.NotebookCellOutputItem.text(output.stdout + output.stderr)
					], cellOutput);
					progress.report({ message: `${data}` });
				});

				token.onCancellationRequested(() => {
					require('tree-kill')(childProcess.pid, 'SIGKILL');
				});

				execution?.token.onCancellationRequested(() => {
					require('tree-kill')(childProcess.pid, 'SIGKILL');
				});

				await new Promise((resolve, reject) => {
					childProcess.on('close', (code: number | null, signal: any) => {
						const endTime = Date.now();;
						const elapsedTimeMsg = ` in ${((endTime - startTime) / 1e6).toFixed(2)} s`;

						fileTaskMap.delete(file.path);
						vscode.commands.executeCommand('setContext', ids.fileListInTask, Array.from(fileTaskMap.keys()));
						if (signal) {
							const msg = `[error] ${processMsg} Killed by signal: ${signal}${elapsedTimeMsg}\n`;
							debugWrite(msg, undefined, "\n");
							reject(new Error(msg)); // Reject promise on signal
						} else if (code === null) {
							const msg = `[error] ${processMsg} Killed by unknown means${elapsedTimeMsg}\n`;
							debugWrite(msg, undefined, "\n");
							execution?.appendOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('1')])]);
							reject(new Error(msg)); // Reject promise on unknown kill
						} else {
							const msg = `[${code === 0 ? 'info' : 'error'}] ${processMsg} Exited with code: ${code}${elapsedTimeMsg}\n`;
							debugWrite(msg, undefined, "\n");
							resolve(msg);
						}
						execution?.end(code === 0, endTime);
					});
				});
			});
		} else {
			execution?.end(false);
		}
	}

	static runFile(file: vscode.Uri, vscLangId: string, execution?: vscode.NotebookCellExecution | undefined) {
		const path = require('path');

		// Follows vscode predefined variables https://code.visualstudio.com/docs/reference/variables-reference#_predefined-variables
		const filePath = this.sanitizePath(file.fsPath);
		const fileBasename = path.basename(filePath);
		const fileBasenameNoExtension = path.basename(file.fsPath, path.extname(file.fsPath));
		const fileExtname = path.extname(filePath);
		const fileDirname = path.dirname(filePath);
		const fileDirnameBasename = path.basename(fileDirname);
		const extTmpDir = this.getExtTmpDir();

		const command = getlanguageRunnerMap()[vscLangId]
			.replace(/\$\{file\}/g, filePath)
			.replace(/\$\{fileBasename\}/g, fileBasename)
			.replace(/\$\{fileBasenameNoExtension\}/g, fileBasenameNoExtension)
			.replace(/\$\{fileExtname\}/g, fileExtname)
			.replace(/\$\{fileDirname\}/g, fileDirname)
			.replace(/\$\{fileDirnameBasename\}/g, fileDirnameBasename)
			.replace(/\$\{pathSeparator\}/g, path.sep)
			.replace(/\$\{\/\}/g, path.sep)
			.replace(/\$\{extTmpDir\}/g, extTmpDir);

		if (getConfig().get(ids.runInTerminal)) {
			this.runInTerminal(command, execution);
		} else {
			this.runWithChildProcess(command, file, execution);
		}
	}

	static async runContent(content: string, mdLangId: string, execution?: vscode.NotebookCellExecution | undefined) {
		const path = require('path');
		const fs = require('fs');

		const extTmpDir = this.getExtTmpDir();

		// Prepare extension temporary directory to place the user source files
		if (!fs.existsSync(extTmpDir)) {
			try {
				fs.mkdirSync(extTmpDir, { recursive: true });
				debugWrite(`[info] Directory ${extTmpDir} created successfully.\n`);
			} catch (err) {
				debugWrite(`[error] Failed to create directory: ${err}\n`);
				return;
			}
		}

		// Empty extension temporary directory if no files are running
		if (fileTaskMap.size === 0) {
			try {
				const files = await fs.promises.readdir(extTmpDir, { withFileTypes: true });
				for (const file of files) {
					const filePath = path.join(extTmpDir, file.name);
					try {
						await fs.promises.rm(filePath, { recursive: true, force: true });
					} catch (err) {
						debugWrite(`[error] Failed to delete ${filePath}: ${err}`);
					}
				}
				debugWrite(`[info] Directory ${extTmpDir} emptied successfully.\n`);
			} catch (err) {
				debugWrite(`[error] Failed to read directory: ${err}\n`);
			}
		}

		const vscLangId = getVscLangId(mdLangId);
		const fileExtname = (vscLangId === 'fortran' && mdLangId !== 'fortran') && '.f90' || languageDetailsMap.get(vscLangId)?.extname || '.' + mdLangId;
		// Same name for same content
		// const fileBasenameNoExtension = require('crypto').createHash('sha256').update(content).digest('hex').slice(0, 8);
		// Just unique name
		const fileBasenameNoExtension = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
		const fileName = fileBasenameNoExtension + fileExtname;
		const filePath = path.join(extTmpDir, fileName);

		const UTF16_LANG_SET = new Set(
			[
				'powershell',
				'vbs'
			]
		)
		const fileContent = UTF16_LANG_SET.has(mdLangId) ? Buffer.concat([Buffer.from('\uFEFF', 'utf16le'), Buffer.from(content, 'utf16le')]) : content;

		try {
			fs.writeFileSync(filePath, fileContent);
		} catch (err) {
			debugWrite(` [error] Failed to write to file: ${err}\n`);
			return;
		}

		this.runFile(vscode.Uri.file(filePath), vscLangId, execution);
	}
}

class MarkdownParser {
	parseMarkdown(content: string): IRawNotebookCell[] {
		/**
		 * Note - the indented code block parsing is basic. It should only be applied inside lists, indentation should be consistent across lines and
		 * between the start and end blocks, etc. This is good enough for typical use cases.
		 */
		function parseCodeBlockStart(line: string): ICodeBlockStart | null {
			const match = line.match(/^([ \t]*)(`{3,})(.*)/);
			return match && {
				indentation: match[1],
				fence: match[2],
				langId: match[3]
			};
		}

		function isCodeBlockStart(line: string): boolean {
			return !!parseCodeBlockStart(line);
		}

		function isCodeBlockEndLine(line: string, codeBlockStart: ICodeBlockStart): boolean {
			return !!line.match(new RegExp(`^${codeBlockStart.indentation}${codeBlockStart.fence}$`));
		}

		const lines = content.split(/\r?\n/g);
		let cells: IRawNotebookCell[] = [];
		let i = 0;

		// Each parse function starts with line i, leaves i on the line after the last line parsed
		for (; i < lines.length;) {
			const leadingWhitespace = i === 0 ? parseWhitespaceLines(true) : '';
			if (i >= lines.length) {
				break;
			}

			const codeBlockMatch = parseCodeBlockStart(lines[i]);
			if (codeBlockMatch) {
				parseCodeBlock(leadingWhitespace, codeBlockMatch);
			} else {
				parseMarkdownParagraph(leadingWhitespace);
			}
		}

		function parseWhitespaceLines(isFirst: boolean): string {
			let start = i;
			const nextNonWhitespaceLineOffset = lines.slice(start).findIndex(l => l !== '');
			let end: number; // will be next line or overflow
			let isLast = false;
			if (nextNonWhitespaceLineOffset < 0) {
				end = lines.length;
				isLast = true;
			} else {
				end = start + nextNonWhitespaceLineOffset;
			}

			i = end;
			const numWhitespaceLines = end - start + (isFirst || isLast ? 0 : 1);
			return '\n'.repeat(numWhitespaceLines);
		}

		function parseCodeBlock(leadingWhitespace: string, codeBlockStart: ICodeBlockStart): void {
			const language = codeBlockStart.langId;
			const startSourceIdx = ++i;
			const startLine = lines[startSourceIdx - 1];
			const startPos = new vscode.Position(startSourceIdx - 1, startLine.length);
			while (true) {
				const currLine = lines[i];
				if (i >= lines.length) {
					break;
				} else if (isCodeBlockEndLine(currLine, codeBlockStart)) {
					i++; // consume block end marker
					break;
				}

				i++;
			}

			const endPos = new vscode.Position(i - 1, lines[i - 1].length);
			const range = new vscode.Range(startPos, endPos);

			const content = lines.slice(startSourceIdx, i - 1)
				.map(line => line.replace(new RegExp('^' + codeBlockStart.indentation), ''))
				.join('\n');
			const trailingWhitespace = parseWhitespaceLines(false);
			cells.push({
				leadingWhitespace: leadingWhitespace,
				indentation: codeBlockStart.indentation,
				fence: codeBlockStart.fence,
				language,
				content,
				trailingWhitespace: trailingWhitespace,
				kind: vscode.NotebookCellKind.Code,
				range: range
			});
		}

		function parseMarkdownParagraph(leadingWhitespace: string): void {
			const startSourceIdx = i;
			const startPos = new vscode.Position(startSourceIdx, 0);
			while (true) {
				if (i >= lines.length) {
					break;
				}

				const currLine = lines[i];
				if (currLine === '' || isCodeBlockStart(currLine)) {
					break;
				}

				i++;
			}

			const endPos = new vscode.Position(i - 1, lines[i - 1].length);
			const range = new vscode.Range(startPos, endPos);

			const content = lines.slice(startSourceIdx, i).join('\n');
			const trailingWhitespace = parseWhitespaceLines(false);
			cells.push({
				language: 'markdown',
				content,
				kind: vscode.NotebookCellKind.Markup,
				leadingWhitespace: leadingWhitespace,
				trailingWhitespace: trailingWhitespace,
				range: range
			});
		}

		return cells;
	}

	getBetweenCellsWhitespace(cells: ReadonlyArray<vscode.NotebookCellData>, idx: number): string {
		const thisCell = cells[idx];
		const nextCell = cells[idx + 1];

		if (!nextCell) {
			return thisCell.metadata?.trailingWhitespace ?? '\n';
		}

		const trailing = thisCell.metadata?.trailingWhitespace;
		const leading = nextCell.metadata?.leadingWhitespace;

		if (typeof trailing === 'string' && typeof leading === 'string') {
			return trailing + leading;
		}

		// One of the cells is new
		const combined = (trailing ?? '') + (leading ?? '');
		if (!combined || combined === '\n') {
			return '\n\n';
		}

		return combined;
	}

	writeCellsToMarkdown(cells: ReadonlyArray<vscode.NotebookCellData>): string {
		let result = '';
		for (let i = 0; i < cells.length; i++) {
			const cell = cells[i];

			if (i === 0) {
				result += cell.metadata?.leadingWhitespace ?? '';
			}

			if (cell.kind === vscode.NotebookCellKind.Code) {
				const indentation = cell.metadata?.raw?.indentation ?? ''
				const languageAlias = languageDetailsMap.get(cell.languageId)?.alias[0];
				const shorterName = languageAlias && languageAlias.length < cell.languageId.length ? languageAlias : cell.languageId;
				const originMdLangId = cell.metadata?.raw?.language;
				const mdLangId = originMdLangId && getVscLangId(originMdLangId) === cell.languageId ? originMdLangId : shorterName;
				const fence = cell.metadata?.raw?.fence ?? '```';
				const codePrefix = indentation + fence + mdLangId + '\n';
				const contents = cell.value.split(/\r?\n/g)
					.map(line => indentation + line)
					.join('\n');
				const codeSuffix = '\n' + indentation + fence;

				result += codePrefix + contents + codeSuffix;
			} else {
				result += cell.value;
			}

			result += this.getBetweenCellsWhitespace(cells, i);
		}
		return result;
	}
}

class NotebookSerializer implements vscode.NotebookSerializer {
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();
	private readonly markdownParser = new MarkdownParser();

	deserializeNotebook(data: Uint8Array, _token: vscode.CancellationToken): vscode.NotebookData | Thenable<vscode.NotebookData> {
		const content = this.decoder.decode(data);
		const cellRawData = this.markdownParser.parseMarkdown(content);
		const cells = cellRawData.map((data) => <vscode.NotebookCellData>{
			kind: data.kind,
			languageId: getVscLangId(data.language),
			metadata: { raw: data, leadingWhitespace: data.leadingWhitespace, trailingWhitespace: data.trailingWhitespace, indentation: data.indentation },
			outputs: [],
			value: data.content
		});

		return {
			cells
		};
	}

	serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Uint8Array | Thenable<Uint8Array> {
		const stringOutput = this.markdownParser.writeCellsToMarkdown(data.cells);
		return this.encoder.encode(stringOutput);
	}
}

class NotebookKernel {
	private _executionOrder = 0;
	private readonly _controller: vscode.NotebookController;

	constructor() {
		this._controller = vscode.notebooks.createNotebookController('markdown-codebook', 'markdown-codebook', 'Markdown Codebook');
		this._controller.supportsExecutionOrder = true;
		this._controller.executeHandler = this._executeAll.bind(this);
	}

	dispose(): void {
		this._controller.dispose();
	}

	private _executeAll(cells: vscode.NotebookCell[], _notebook: vscode.NotebookDocument, _controller: vscode.NotebookController): void {
		for (const cell of cells) {
			this._doExecution(cell);
		}
	}

	private async _doExecution(cell: vscode.NotebookCell): Promise<void> {
		const execution = this._controller.createNotebookCellExecution(cell);
		execution.executionOrder = ++this._executionOrder;
		await Runner.runContent(cell.document.getText(), cell.document.languageId, execution);
	}

	setSupportedLanguages(supportedLanguages: string[]) {
		this._controller.supportedLanguages = supportedLanguages;
	}
}

function initMarkdownCodeLens(context: vscode.ExtensionContext,) {
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
			const markdownParser = new MarkdownParser();

			markdownParser.parseMarkdown(document.getText()).filter(c => c.kind === vscode.NotebookCellKind.Code).forEach(rawCell => {
				codeLenses.push(new vscode.CodeLens(new vscode.Range(rawCell.range.start, rawCell.range.start), {
					command: ids.copyCodeBlock,
					title: getCodeLensCommandTitle(ids.copyCodeBlock),
					tooltip: vscode.l10n.t('Copy code block'),
					arguments: [rawCell]
				}));

				const runner = getlanguageRunnerMap()[getVscLangId(rawCell.language)];
				if (!isWeb && runner) {
					codeLenses.push(new vscode.CodeLens(new vscode.Range(rawCell.range.start, rawCell.range.start), {
						command: ids.runCodeBlock,
						title: getCodeLensCommandTitle(ids.runCodeBlock),
						tooltip: vscode.l10n.t('Run code block{0}', `\n${runner}`),
						arguments: [rawCell]
					}));
				}
			});
		}
		return codeLenses;
	}

	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: '*', language: 'markdown' }, {
		provideCodeLenses: (document: vscode.TextDocument, token: vscode.CancellationToken) => {
			return provideMarkdownCodeLenses(document);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand(ids.copyCodeBlock, (date) => {
		vscode.env.clipboard.writeText(date.content).then(() => {
			vscode.window.showInformationMessage(vscode.l10n.t('Copied code block to clipboard'))
		}, (error) => {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy code block: {0}', error));
		});
	}));

	if (!isWeb) {
		context.subscriptions.push(vscode.commands.registerCommand(ids.runCodeBlock, (data) => {
			Runner.runContent(data.content, data.language);
		}));
	}
}

function initRunButton(context: vscode.ExtensionContext) {
	if (!isWeb) {
		vscode.commands.executeCommand('setContext', ids.enableRunButton, getConfig().get(ids.enableRunButton));
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(ids.enableRunButton)) {
				vscode.commands.executeCommand('setContext', ids.enableRunButton, getConfig().get(ids.enableRunButton));
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand(ids.runFile, (file) => {
			const document = file ? vscode.workspace.textDocuments.find(d => d.uri.path === file.path) : vscode.window.activeTextEditor?.document;
			if (document) {
				Runner.runFile(document.uri, document.languageId);
			}
		}));

		context.subscriptions.push(vscode.commands.registerCommand(ids.stopTask, (file) => {
			const filePath = file ? file.path : vscode.window.activeTextEditor?.document.uri.path;
			if (filePath && fileTaskMap.has(filePath)) {
				require('tree-kill')(fileTaskMap.get(filePath).pid, 'SIGKILL');
			}
		}));
	}
}

function initNotebook(context: vscode.ExtensionContext): NotebookKernel | undefined {
	const providerOptions = {
		transientMetadata: {
			runnable: true,
			editable: true,
			custom: true,
		},
		transientOutputs: true
	};
	if (isWeb) {
		context.subscriptions.push(vscode.workspace.registerNotebookSerializer('markdown-codebook', new NotebookSerializer(), providerOptions));
	} else {

		const notebookKernel = new NotebookKernel();
		context.subscriptions.push(vscode.workspace.registerNotebookSerializer('markdown-codebook', new NotebookSerializer(), providerOptions), notebookKernel);
		return notebookKernel;
	}
	return undefined;
}

function initConfigUpdater(context: vscode.ExtensionContext, notebookKernel: NotebookKernel | undefined) {
	const toggleMap = new Map();
	toggleMap.set(ids.toggleRunInTerminal, ids.runInTerminal);
	toggleMap.set(ids.toggleShowDebugInfo, ids.showDebugInfo);
	toggleMap.set(ids.toggleClearOutputBeforeRun, ids.clearOutputBeforeRun);

	toggleMap.forEach((value, key) => {
		context.subscriptions.push(vscode.commands.registerCommand(key, (file) => {
			vscode.workspace.getConfiguration().update(value, !getConfig().get(value), vscode.ConfigurationTarget.Global);
		}));
	});

	const supportedLanguages = Object.keys(getlanguageRunnerMap()).filter(k => getlanguageRunnerMap()[k]);
	vscode.commands.executeCommand('setContext', ids.supportedLanguages, supportedLanguages);
	notebookKernel?.setSupportedLanguages(supportedLanguages);

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(ids.languageRunnerMap)) {
			const supportedLanguages = Object.keys(getlanguageRunnerMap()).filter(k => getlanguageRunnerMap()[k]);
			vscode.commands.executeCommand('setContext', ids.supportedLanguages, supportedLanguages);
			notebookKernel?.setSupportedLanguages(supportedLanguages);
		}
	}));
}

export function activate(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand('setContext', ids.isWeb, isWeb);
	debugWrite(`[info] isWeb: ${isWeb}\n`);

	initMarkdownCodeLens(context);
	initRunButton(context);
	const notebookKernel = initNotebook(context);
	initConfigUpdater(context, notebookKernel);
	vscode.window.onDidChangeActiveTerminal(t => Runner.terminal = t);
}

export async function deactivate() { }
