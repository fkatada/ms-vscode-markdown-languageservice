/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as lsp from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';
import { getLsConfiguration, LsConfiguration } from './config';
import { MdExtractLinkDefinitionCodeActionProvider } from './languageFeatures/codeActions/extractLinkDef';
import { MdRemoveLinkDefinitionCodeActionProvider } from './languageFeatures/codeActions/removeLinkDefinition';
import { MdDefinitionProvider } from './languageFeatures/definitions';
import { DiagnosticComputer, DiagnosticOptions, DiagnosticsManager, IPullDiagnosticsManager } from './languageFeatures/diagnostics';
import { MdDocumentHighlightProvider } from './languageFeatures/documentHighlights';
import { createWorkspaceLinkCache, MdLinkProvider, ResolvedDocumentLinkTarget } from './languageFeatures/documentLinks';
import { MdDocumentSymbolProvider } from './languageFeatures/documentSymbols';
import { FileRename, MdFileRenameProvider } from './languageFeatures/fileRename';
import { MdFoldingProvider } from './languageFeatures/folding';
import { MdHoverProvider } from './languageFeatures/hover';
import { MdOrganizeLinkDefinitionProvider } from './languageFeatures/organizeLinkDefs';
import { MdPathCompletionProvider, PathCompletionOptions } from './languageFeatures/pathCompletions';
import { MdReferencesProvider } from './languageFeatures/references';
import { MdRenameProvider } from './languageFeatures/rename';
import { MdSelectionRangeProvider } from './languageFeatures/smartSelect';
import { MdUpdatePastedLinksProvider } from './languageFeatures/updatePastedLinks';
import { MdWorkspaceSymbolProvider } from './languageFeatures/workspaceSymbols';
import { ILogger } from './logging';
import { IMdParser } from './parser';
import { MdTableOfContentsProvider } from './tableOfContents';
import { ITextDocument } from './types/textDocument';
import { isWorkspaceWithFileWatching, IWorkspace } from './workspace';

export { LsConfiguration, PreferredMdPathExtensionStyle } from './config';
export { DiagnosticCode, DiagnosticLevel, DiagnosticOptions, IPullDiagnosticsManager } from './languageFeatures/diagnostics';
export { ResolvedDocumentLinkTarget } from './languageFeatures/documentLinks';
export { FileRename } from './languageFeatures/fileRename';
export { IncludeWorkspaceHeaderCompletions, PathCompletionOptions as MdPathCompletionOptions } from './languageFeatures/pathCompletions';
export { RenameNotSupportedAtLocationError } from './languageFeatures/rename';
export { ILogger, LogLevel } from './logging';
export { IMdParser, Token } from './parser';
export { githubSlugifier, ISlug, ISlugifier } from './slugify';
export { ITextDocument } from './types/textDocument';
export { ContainingDocumentContext, FileStat, FileWatcherOptions, IFileSystemWatcher, IWorkspace, IWorkspaceWithWatching } from './workspace';

/**
 * Provides language tooling methods for working with markdown.
 */
export interface IMdLanguageService {

	/**
	 * Get all links of a markdown file.
	 *
	 * Note that you must invoke {@link IMdLanguageService.resolveDocumentLink} on each link before executing the link.
	 */
	getDocumentLinks(document: ITextDocument, token: lsp.CancellationToken): Promise<lsp.DocumentLink[]>;

	/**
	 * Resolves a link from {@link IMdLanguageService.getDocumentLinks}.
	 *
	 * This fills in the target on the link.
	 *
	 * @returns The resolved link or `undefined` if the passed in link should be used
	 */
	resolveDocumentLink(link: lsp.DocumentLink, token: lsp.CancellationToken): Promise<lsp.DocumentLink | undefined>;

	/**
	 * Try to resolve the resources that a link in a markdown file points to.
	 * 
	 * @param linkText The original text of the link
	 * @param fromResource The resource that contains the link.
	 * 
	 * @returns The resolved target or undefined if it could not be resolved.
	 */
	resolveLinkTarget(linkText: string, fromResource: URI, token: lsp.CancellationToken): Promise<ResolvedDocumentLinkTarget | undefined>;

	/**
	 * Get the symbols of a markdown file.
	 *
	 * @returns The headers and optionally also the link definitions in the file
	 */
	getDocumentSymbols(document: ITextDocument, options: { readonly includeLinkDefinitions?: boolean }, token: lsp.CancellationToken): Promise<lsp.DocumentSymbol[]>;

	/**
	 * Get the folding ranges of a markdown file.
	 *
	 * This returns folding ranges for:
	 *
	 * - Header sections
	 * - Regions
	 * - List and other block element
	 */
	getFoldingRanges(document: ITextDocument, token: lsp.CancellationToken): Promise<lsp.FoldingRange[]>;

	/**
	 * Get the selection ranges of a markdown file.
	 */
	getSelectionRanges(document: ITextDocument, positions: lsp.Position[], token: lsp.CancellationToken): Promise<lsp.SelectionRange[] | undefined>;

	/**
	 * Get the symbols for all markdown files in the current workspace.
	 *
	 * Returns all headers in the workspace.
	 */
	getWorkspaceSymbols(query: string, token: lsp.CancellationToken): Promise<lsp.WorkspaceSymbol[]>;

	/**
	 * Get completions items at a given position in a markdown file.
	 */
	getCompletionItems(document: ITextDocument, position: lsp.Position, context: PathCompletionOptions, token: lsp.CancellationToken): Promise<lsp.CompletionItem[]>;

	/**
	 * Get the references to a symbol at the current location.
	 *
	 * Supports finding references to headers and links.
	 */
	getReferences(document: ITextDocument, position: lsp.Position, context: lsp.ReferenceContext, token: lsp.CancellationToken): Promise<lsp.Location[]>;

	/**
	 * Get the references to a given file.
	 */
	getFileReferences(resource: URI, token: lsp.CancellationToken): Promise<lsp.Location[]>;

	/**
	 * Get the definition of the symbol at the current location.
	 *
	 * Supports finding headers from fragments links or reference link definitions.
	 */
	getDefinition(document: ITextDocument, position: lsp.Position, token: lsp.CancellationToken): Promise<lsp.Definition | undefined>;

	/**
	 * Organizes all link definitions in the file by grouping them to the bottom of the file, sorting them, and optionally
	 * removing any unused definitions.
	 *
	 * @returns A set of text edits. May be empty if no edits are required (e.g. the definitions are already sorted at
	 * the bottom of the file).
	 */
	organizeLinkDefinitions(document: ITextDocument, options: { readonly removeUnused?: boolean }, token: lsp.CancellationToken): Promise<lsp.TextEdit[]>;

	/**
	 * Prepare for showing rename UI.
	 *
	 * Indicates if rename is supported. If it is, returns the range of symbol being renamed as well as the placeholder to show to the user for the rename.
	 */
	prepareRename(document: ITextDocument, position: lsp.Position, token: lsp.CancellationToken): Promise<{ range: lsp.Range; placeholder: string } | undefined>;

	/**
	 * Get the edits for a rename operation.
	 *
	 * @returns A workspace edit that performs the rename or undefined if the rename cannot be performed.
	 */
	getRenameEdit(document: ITextDocument, position: lsp.Position, nameName: string, token: lsp.CancellationToken): Promise<lsp.WorkspaceEdit | undefined>;

	/**
	 * Get the edits for a file rename. This update links to the renamed files as well as links within the renamed files.
	 *
	 * This should be invoked after the rename has already happened (i.e. the workspace should reflect the file system state post rename).
	 *
	 * You can pass in uris to resources or directories. However if you pass in multiple edits, these edits must not overlap/conflict.
	 *
	 * @returns An object with a workspace edit that performs the rename and a list of old file uris that effected the edit. Returns undefined if the rename cannot be performed. 
	 */
	getRenameFilesInWorkspaceEdit(edits: readonly FileRename[], token: lsp.CancellationToken): Promise<{ participatingRenames: readonly FileRename[]; edit: lsp.WorkspaceEdit } | undefined>;

	/**
	 * Get code actions for a selection in a file.
	 *
	 * Returned code actions may be disabled.
	 */
	getCodeActions(document: ITextDocument, range: lsp.Range, context: lsp.CodeActionContext, token: lsp.CancellationToken): Promise<lsp.CodeAction[]>;

	/**
	 * Get document highlights for a position in the document.
	 */
	getDocumentHighlights(document: ITextDocument, position: lsp.Position, token: lsp.CancellationToken): Promise<lsp.DocumentHighlight[]>;

	/**
	 * Called on copy to support update links when they are pasted.
	 * 
	 * @param document The document being copied from.
	 * @param ranges The ranges being copied.
	 * @param token A cancellation token.
	 * 
	 * @returns A json string with internal metadata. This metadata is passed to {@linkcode  getUpdatePastedLinksEdit}.
	 * It has no meaning on its own.
	 */
	prepareUpdatePastedLinks(document: ITextDocument, ranges: readonly lsp.Range[], token: lsp.CancellationToken): Promise<string>;

	/**
	 * Get the edits that update links when copy pasting from one Markdown document to another.
	 * 
	 * Must be used with {@linkcode prepareUpdatePastedLinks}.
	 * 
	 * @param document The document being pasted into.
	 * @param paste Edits that apply the paste. These must not overlap.
	 * @param rawCopyMetadata String blob generated by {@linkcode prepareUpdatePastedLinks}.
	 * @param token A cancellation token.
	 * 
	 * @returns A set of edits that applies the full paste if any links were rewritten. Returns undefined if no links were rewritten.
	 */
	getUpdatePastedLinksEdit(document: ITextDocument, paste: readonly lsp.TextEdit[], rawCopyMetadata: string, token: lsp.CancellationToken): Promise<lsp.TextEdit[] | undefined>;

	/**
	 * Get the hover information for a position in the document.
	 */
	getHover(document: ITextDocument, pos: lsp.Position, token: lsp.CancellationToken): Promise<lsp.Hover | undefined>;

	/**
	 * Compute diagnostics for a given file.
	 *
	 * Note that this function is stateless and re-validates all links every time you make the request. Use {@link IMdLanguageService.createPullDiagnosticsManager}
	 * to more efficiently get diagnostics.
	 */
	computeDiagnostics(doc: ITextDocument, options: DiagnosticOptions, token: lsp.CancellationToken): Promise<lsp.Diagnostic[]>;

	/**
	 * Create a stateful object that is more efficient at computing diagnostics across repeated calls and workspace changes.
	 *
	 * This requires a {@link IWorkspace workspace} that {@link IWorkspaceWithWatching supports file watching}.
	 *
	 * Note that you must dispose of the returned object once you are done using it.
	 */
	createPullDiagnosticsManager(): IPullDiagnosticsManager;

	/**
	 * Dispose of the language service, freeing any associated resources.
	 */
	dispose(): void;
}

/**
 * Initialization options for creating a new {@link IMdLanguageService}.
 */
export interface LanguageServiceInitialization extends Partial<LsConfiguration> {

	/**
	 * The {@link IWorkspace workspace} that the  {@link IMdLanguageService language service} uses to work with files. 
	 */
	readonly workspace: IWorkspace;

	/**
	 * The {@link IMdParser markdown parsing engine} that the  {@link IMdLanguageService language service} uses to
	 * process Markdown source. 
	 */
	readonly parser: IMdParser;

	/**
	 * The {@link ILogger logger} that the  {@link IMdLanguageService language service} use for logging messages.
	 */
	readonly logger: ILogger;
}

/**
 * Create a new instance of the {@link IMdLanguageService language service}.
 */
export function createLanguageService(init: LanguageServiceInitialization): IMdLanguageService {
	const config = getLsConfiguration(init);
	const logger = init.logger;

	const tocProvider = new MdTableOfContentsProvider(init.parser, init.workspace, logger);
	const foldingProvider = new MdFoldingProvider(init.parser, tocProvider, logger);
	const linkProvider = new MdLinkProvider(config, init.parser, init.workspace, tocProvider, logger);
	const pathCompletionProvider = new MdPathCompletionProvider(config, init.workspace, init.parser, linkProvider, tocProvider);
	const linkCache = createWorkspaceLinkCache(init.parser, init.workspace);
	const smartSelectProvider = new MdSelectionRangeProvider(init.parser, tocProvider, linkProvider, logger);
	const referencesProvider = new MdReferencesProvider(config, init.parser, init.workspace, tocProvider, linkCache, logger);
	const definitionsProvider = new MdDefinitionProvider(config, init.workspace, tocProvider, linkCache);
	const renameProvider = new MdRenameProvider(config, init.workspace, init.parser, referencesProvider, tocProvider, init.parser.slugifier, logger);
	const fileRenameProvider = new MdFileRenameProvider(config, init.workspace, linkCache, referencesProvider);
	const diagnosticsComputer = new DiagnosticComputer(config, init.workspace, linkProvider, tocProvider, logger);
	const docSymbolProvider = new MdDocumentSymbolProvider(tocProvider, linkProvider, logger);
	const workspaceSymbolProvider = new MdWorkspaceSymbolProvider(init.workspace, docSymbolProvider);
	const organizeLinkDefinitions = new MdOrganizeLinkDefinitionProvider(linkProvider);
	const documentHighlightProvider = new MdDocumentHighlightProvider(config, tocProvider, linkProvider);
	const rewritePastedLinksProvider = new MdUpdatePastedLinksProvider(config, linkProvider);
	const hoverProvider = new MdHoverProvider(linkProvider);

	const extractCodeActionProvider = new MdExtractLinkDefinitionCodeActionProvider(linkProvider);
	const removeLinkDefinitionActionProvider = new MdRemoveLinkDefinitionCodeActionProvider();

	return Object.freeze<IMdLanguageService>({
		dispose: () => {
			linkCache.dispose();
			tocProvider.dispose();
			workspaceSymbolProvider.dispose();
			linkProvider.dispose();
			referencesProvider.dispose();
		},
		getDocumentLinks: linkProvider.provideDocumentLinks.bind(linkProvider),
		resolveDocumentLink: linkProvider.resolveDocumentLink.bind(linkProvider),
		resolveLinkTarget: linkProvider.resolveLinkTarget.bind(linkProvider),
		getDocumentSymbols: docSymbolProvider.provideDocumentSymbols.bind(docSymbolProvider),
		getFoldingRanges: foldingProvider.provideFoldingRanges.bind(foldingProvider),
		getSelectionRanges: smartSelectProvider.provideSelectionRanges.bind(smartSelectProvider),
		getWorkspaceSymbols: workspaceSymbolProvider.provideWorkspaceSymbols.bind(workspaceSymbolProvider),
		getCompletionItems: pathCompletionProvider.provideCompletionItems.bind(pathCompletionProvider),
		getReferences: referencesProvider.provideReferences.bind(referencesProvider),
		getFileReferences: async (resource: URI, token: lsp.CancellationToken): Promise<lsp.Location[]> => {
			return (await referencesProvider.getReferencesToFileInWorkspace(resource, token)).map(x => x.location);
		},
		getDefinition: definitionsProvider.provideDefinition.bind(definitionsProvider),
		organizeLinkDefinitions: organizeLinkDefinitions.getOrganizeLinkDefinitionEdits.bind(organizeLinkDefinitions),
		prepareRename: renameProvider.prepareRename.bind(renameProvider),
		getRenameEdit: renameProvider.provideRenameEdits.bind(renameProvider),
		getRenameFilesInWorkspaceEdit: fileRenameProvider.getRenameFilesInWorkspaceEdit.bind(fileRenameProvider),
		getCodeActions: async (doc: ITextDocument, range: lsp.Range, context: lsp.CodeActionContext, token: lsp.CancellationToken): Promise<lsp.CodeAction[]> => {
			return (await Promise.all([
				extractCodeActionProvider.getActions(doc, range, context, token),
				Array.from(removeLinkDefinitionActionProvider.getActions(doc, range, context)),
			])).flat();
		},
		getDocumentHighlights: (document: ITextDocument, position: lsp.Position, token: lsp.CancellationToken): Promise<lsp.DocumentHighlight[]> => {
			return documentHighlightProvider.getDocumentHighlights(document, position, token);
		},
		prepareUpdatePastedLinks: rewritePastedLinksProvider.prepareDocumentPaste.bind(rewritePastedLinksProvider),
		getUpdatePastedLinksEdit: rewritePastedLinksProvider.provideDocumentPasteEdits.bind(rewritePastedLinksProvider),
		getHover: hoverProvider.provideHover.bind(hoverProvider),
		computeDiagnostics: async (doc: ITextDocument, options: DiagnosticOptions, token: lsp.CancellationToken): Promise<lsp.Diagnostic[]> => {
			return (await diagnosticsComputer.compute(doc, options, token))?.diagnostics;
		},
		createPullDiagnosticsManager: () => {
			if (!isWorkspaceWithFileWatching(init.workspace)) {
				throw new Error(`Workspace does not support file watching. Diagnostics manager not supported`);
			}
			return new DiagnosticsManager(config, init.workspace, linkProvider, tocProvider, logger);
		}
	});
}
