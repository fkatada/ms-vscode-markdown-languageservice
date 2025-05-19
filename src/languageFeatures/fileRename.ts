/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';
import * as lsp from 'vscode-languageserver-protocol';
import { URI, Utils } from 'vscode-uri';
import { LsConfiguration, isExcludedPath } from '../config';
import { HrefKind, MdLink } from '../types/documentLink';
import { ITextDocument, getDocUri } from '../types/textDocument';
import { WorkspaceEditBuilder } from '../util/editBuilder';
import { removeNewUriExtIfNeeded, resolveInternalDocumentLink } from '../util/mdLinks';
import { isParentDir, isSameResource, looksLikeMarkdownUri } from '../util/path';
import { IWorkspace } from '../workspace';
import { MdWorkspaceInfoCache } from '../workspaceCache';
import { MdReferenceKind, MdReferencesProvider } from './references';
import { getLinkRenameEdit, getLinkRenameText } from './rename';


export interface FileRename {
	readonly oldUri: URI;
	readonly newUri: URI;
}

export interface FileRenameResponse {
	participatingRenames: readonly FileRename[];
	edit: lsp.WorkspaceEdit;
}

export class MdFileRenameProvider {

	readonly #config: LsConfiguration;
	readonly #workspace: IWorkspace;
	readonly #linkCache: MdWorkspaceInfoCache<readonly MdLink[]>;
	readonly #referencesProvider: MdReferencesProvider;

	public constructor(
		config: LsConfiguration,
		workspace: IWorkspace,
		linkCache: MdWorkspaceInfoCache<readonly MdLink[]>,
		referencesProvider: MdReferencesProvider,
	) {
		this.#config = config;
		this.#workspace = workspace;
		this.#linkCache = linkCache;
		this.#referencesProvider = referencesProvider;
	}

	async getRenameFilesInWorkspaceEdit(edits: readonly FileRename[], token: lsp.CancellationToken): Promise<FileRenameResponse | undefined> {
		const builder = new WorkspaceEditBuilder();
		const participatingRenames: FileRename[] = [];

		for (const edit of edits) {
			const stat = await this.#workspace.stat(edit.newUri);
			if (token.isCancellationRequested) {
				return undefined;
			}

			if (await (stat?.isDirectory ? this.#addDirectoryRenameEdits(edit, builder, token) : this.#addSingleFileRenameEdits(edit, edits, builder, token))) {
				participatingRenames.push(edit);
			}

			if (token.isCancellationRequested) {
				return undefined;
			}
		}

		return { participatingRenames, edit: builder.getEdit() };
	}

	async #addSingleFileRenameEdits(edit: FileRename, allEdits: readonly FileRename[], builder: WorkspaceEditBuilder, token: lsp.CancellationToken): Promise<boolean> {
		let didParticipate = false;

		// Update all references to the file
		if (await this.#addEditsForReferencesToFile(edit, builder, token)) {
			didParticipate = true;
		}

		if (token.isCancellationRequested) {
			return false;
		}

		// If the file moved was markdown, we also need to update links in the file itself
		if (await this.#tryAddEditsInSelf(edit, allEdits, builder)) {
			didParticipate = true;
		}

		return didParticipate;
	}

	async #addDirectoryRenameEdits(edit: FileRename, builder: WorkspaceEditBuilder, token: lsp.CancellationToken): Promise<boolean> {
		// First update every link that points to something in the moved dir
		const allLinksInWorkspace = await this.#linkCache.entries();
		if (token.isCancellationRequested) {
			return false;
		}

		let didParticipate = false;
		for (const [docUri, links] of allLinksInWorkspace) {
			for (const link of links) {
				if (link.href.kind !== HrefKind.Internal || link.source.hrefText.startsWith('#')) {
					continue;
				}

				// Update links to the moved dir
				if (isParentDir(edit.oldUri, link.href.path)) {
					const relative = path.posix.relative(edit.oldUri.path, link.href.path.path);
					const newUri = edit.newUri.with({
						path: path.posix.join(edit.newUri.path, relative)
					});

					if (this.#addLinkRenameEdit(docUri, link, newUri, builder)) {
						didParticipate = true;
						continue;
					}
				}

				// If the link was within a file in the moved dir but traversed out of it, we also need to update the path
				if (link.source.hrefText.startsWith('..') && isParentDir(edit.newUri, docUri)) {
					// Resolve the link relative to the old file path
					const oldDocUri = docUri.with({
						path: Utils.joinPath(edit.oldUri, path.posix.relative(edit.newUri.path, docUri.path)).path
					});

					const oldLink = resolveInternalDocumentLink(oldDocUri, link.source.hrefText, this.#workspace);
					if (oldLink) {
						let newPathText: string;
						if (isParentDir(edit.oldUri, oldLink.resource)) {
							// The link still points within the directory being moved.
							// This means we just need to normalize the path it in case it was referencing any old names.
							const rootDir = Utils.dirname(oldDocUri);
							newPathText = './' + path.posix.relative(rootDir.path, oldLink.resource.path);
						} else {
							const rootDir = Utils.dirname(docUri);
							newPathText = path.posix.relative(rootDir.path, oldLink.resource.path);
						}

						const replacementPath = encodeURI(newPathText);
						if (replacementPath !== link.source.hrefPathText) {
							const { range, newText } = getLinkRenameEdit(link, replacementPath);
							builder.replace(docUri, range, newText);
							didParticipate = true;
						}
					}
				}
			}
		}

		return didParticipate;
	}

	/**
	 * Try to add edits for when a markdown file has been renamed.
	 * In this case we also need to update links within the file.
	 */
	async #tryAddEditsInSelf(edit: FileRename, allEdits: readonly FileRename[], builder: WorkspaceEditBuilder): Promise<boolean> {
		if (!looksLikeMarkdownUri(this.#config, edit.newUri)) {
			return false;
		}

		if (isExcludedPath(this.#config, edit.newUri)) {
			return false;
		}

		const doc = await this.#workspace.openMarkdownDocument(edit.newUri);
		if (!doc) {
			return false;
		}

		const links = (await this.#linkCache.getForDocs([doc]))[0];

		let didParticipate = false;
		for (const link of links) {
			if (await this.#addEditsForLinksInSelf(doc, link, edit, allEdits, builder)) {
				didParticipate = true;
			}
		}
		return didParticipate;
	}

	async #addEditsForLinksInSelf(doc: ITextDocument, link: MdLink, edit: FileRename, allEdits: readonly FileRename[], builder: WorkspaceEditBuilder): Promise<boolean> {
		if (link.href.kind !== HrefKind.Internal) {
			return false;
		}

		if (link.source.hrefText.startsWith('#')) {
			// No rewrite needed as we are referencing the current doc implicitly
			return false;
		}

		if (link.source.hrefText.startsWith('/')) {
			// We likely don't need to update anything since an absolute path is used
			return false;
		}

		// Resolve the link relative to the old file path
		let oldLink = resolveInternalDocumentLink(edit.oldUri, link.source.hrefText, this.#workspace);
		if (!oldLink) {
			return false;
		}

		// See if the old link was effected by one of the renames
		for (const edit of allEdits) {
			if (isSameResource(edit.oldUri, oldLink.resource) || isParentDir(edit.oldUri, oldLink.resource)) {
				oldLink = { resource: Utils.joinPath(edit.newUri, path.posix.relative(edit.oldUri.path, oldLink.resource.path)), linkFragment: oldLink.linkFragment };
				break;
			}
		}

		return this.#addLinkRenameEdit(getDocUri(doc), link, oldLink.resource, builder);
	}

	/**
	 * Update links across the workspace for the new file name
	 */
	async #addEditsForReferencesToFile(edit: FileRename, builder: WorkspaceEditBuilder, token: lsp.CancellationToken): Promise<boolean> {
		if (isExcludedPath(this.#config, edit.newUri)) {
			return false;
		}

		const refs = await this.#referencesProvider.getReferencesToFileInWorkspace(edit.oldUri, token);
		if (token.isCancellationRequested) {
			return false;
		}

		let didParticipate = false;
		for (const ref of refs) {
			if (ref.kind === MdReferenceKind.Link) {
				if (this.#addLinkRenameEdit(URI.parse(ref.location.uri), ref.link, edit.newUri, builder)) {
					didParticipate = true;
				}
			}
		}
		return didParticipate;
	}

	#addLinkRenameEdit(doc: URI, link: MdLink, newUri: URI, builder: WorkspaceEditBuilder): boolean {
		if (link.href.kind !== HrefKind.Internal) {
			return false;
		}

		const newFilePath = removeNewUriExtIfNeeded(this.#config, link.href, newUri);
		const newLinkText = getLinkRenameText(this.#workspace, link.source, newFilePath, link.source.hrefText.startsWith('.'));
		if (typeof newLinkText === 'string') {
			const { range, newText } = getLinkRenameEdit(link, newLinkText);
			builder.replace(doc, range, newText);
			return true;
		}
		return false;
	}
}
