/**
 * What the engine is told its settings are.
 *
 * The vendored worker was built for `detachhead.basedpyright` and asks for its
 * config under that extension's section names. Contributing those names in our
 * own manifest works right up until a user installs both extensions: VS Code
 * allows one owner per setting name and silently drops the second registration.
 * Ours losing leaves `typeshedPaths` defaulted to `[]`, where nothing resolves
 * at all, `builtins` included; theirs losing points their extension at a
 * typeshed root that exists only inside our in-memory filesystem.
 *
 * So the client answers `workspace/configuration` itself. The engine's section
 * names stay in this file, every user-facing setting is `micropython-lsp.*`, and
 * no `python.*` or `basedpyright.*` value a user set for another extension can
 * reach this engine.
 *
 * Everything the engine will read is below, should one ever be worth offering as
 * a `micropython-lsp.*` setting of our own. Anything left unanswered keeps the
 * engine's built-in default.
 *
 * `basedpyright.analysis`, falling back to `python.analysis`:
 *   typeshedPaths*  logLevel*  stubPath  extraPaths  include  exclude  ignore
 *   typeCheckingMode  diagnosticSeverityOverrides  diagnosticMode  openFilesOnly
 *   useLibraryCodeForTypes  autoSearchPaths  autoImportCompletions
 *   autoFormatStrings  inlayHints  useTypingExtensions  baselineFile
 *   baselineMode  configFilePath  logTypeEvaluationTime
 *   typeEvaluationTimeThreshold  fileEnumerationTimeout
 *
 * `basedpyright`, falling back to `pyright`:
 *   typeCheckingMode  openFilesOnly  useLibraryCodeForTypes
 *   disableLanguageServices  disableTaggedHints  disableOrganizeImports
 *
 * `python`: pythonPath, venvPath. Both name paths on a real disk, so neither
 * means anything here.
 *
 * (*) the two we answer.
 */

/** The typeshed root seeded into the engine's filesystem, not a path on disk. */
export const SERVER_TYPESHED = 'file:///typeshed';

/** The `micropython-lsp.*` settings that reach the engine. */
export interface UserSettings {
	readonly logLevel: string;
}

/**
 * Never returns null, for any section: pyright reads properties straight off the
 * reply. An empty object for `basedpyright` is also what stops it asking for the
 * `pyright` section next, where another extension's `disableLanguageServices`
 * would silence this one.
 */
export function serverSettings(section: string | null | undefined, user: UserSettings): Record<string, unknown> {
	if (section === 'basedpyright.analysis') {
		return { typeshedPaths: [SERVER_TYPESHED], logLevel: user.logLevel };
	}
	return {};
}
