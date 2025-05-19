/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { HTMLElement, parse } from 'node-html-parser';
import * as lsp from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';
import { LsConfiguration } from '../config';
import { ILogger, LogLevel } from '../logging';
import { IMdParser, Token } from '../parser';
import { MdTableOfContentsProvider } from '../tableOfContents';
import { ExternalHref, HrefKind, InternalHref, LinkDefinitionSet, MdLink, MdLinkDefinition, MdLinkKind } from '../types/documentLink';
import { translatePosition } from '../types/position';
import { rangeContains } from '../types/range';
import { ITextDocument, getDocUri, getLine } from '../types/textDocument';
import { coalesce } from '../util/arrays';
import { Disposable } from '../util/dispose';
import { htmlTagPathAttrs } from '../util/html';
import { resolveInternalDocumentLink } from '../util/mdLinks';
import { parseLocationInfoFromFragment } from '../util/path';
import { r } from '../util/string';
import { tryDecodeUri } from '../util/uri';
import { IWorkspace, tryAppendMarkdownFileExtension } from '../workspace';
import { MdDocumentInfoCache, MdWorkspaceInfoCache } from '../workspaceCache';


function createHref(
	sourceDocUri: URI,
	link: string,
	workspace: IWorkspace,
): ExternalHref | InternalHref | undefined {
	if (/^[a-z\-][a-z\-]+:/i.test(link)) {
		// Looks like a uri
		try {
			return { kind: HrefKind.External, uri: URI.parse(tryDecodeUri(link)) };
		} catch (e) {
			console.warn(r`Failed to parse link ${link} in ${sourceDocUri.toString(true)}`);
			return undefined;
		}
	}

	const resolved = resolveInternalDocumentLink(sourceDocUri, link, workspace);
	if (!resolved) {
		return undefined;
	}

	return {
		kind: HrefKind.Internal,
		path: resolved.resource,
		fragment: resolved.linkFragment,
	};
}

function createMdLink(
	document: ITextDocument,
	targetText: string,
	preHrefText: string,
	rawLink: string,
	matchIndex: number,
	fullMatch: string,
	titleMatch: string | undefined,
	workspace: IWorkspace,
): MdLink | undefined {
	const isAngleBracketLink = rawLink.startsWith('<');
	const link = stripAngleBrackets(rawLink);

	let linkTarget: ExternalHref | InternalHref | undefined;
	try {
		linkTarget = createHref(getDocUri(document), link, workspace);
	} catch {
		return undefined;
	}
	if (!linkTarget) {
		return undefined;
	}

	const pre = targetText + preHrefText;
	const linkStartOffset = matchIndex;
	const linkStart = document.positionAt(linkStartOffset);
	const linkEnd = document.positionAt(linkStartOffset + fullMatch.length);

	const targetStart = document.positionAt(linkStartOffset + targetText.length);
	const targetRange: lsp.Range = { start: targetStart, end: linkEnd };

	const hrefStartOffset = linkStartOffset + pre.length + (isAngleBracketLink ? 1 : 0);
	const hrefStart = document.positionAt(hrefStartOffset);
	const hrefEnd = document.positionAt(hrefStartOffset + link.length);
	const hrefRange: lsp.Range = { start: hrefStart, end: hrefEnd };

	let titleRange: lsp.Range | undefined;
	if (titleMatch) {
		const indexOfTitleInLink = fullMatch.indexOf(titleMatch);
		if (indexOfTitleInLink >= 0) {
			const titleStartOffset = linkStartOffset + indexOfTitleInLink;
			titleRange = lsp.Range.create(
				document.positionAt(titleStartOffset),
				document.positionAt(titleStartOffset + titleMatch.length));
		}
	}

	return {
		kind: MdLinkKind.Link,
		href: linkTarget,
		source: {
			hrefText: link,
			resource: getDocUri(document),
			range: { start: linkStart, end: linkEnd },
			targetRange,
			hrefRange,
			isAngleBracketLink,
			...getLinkSourceFragmentInfo(document, link, hrefStart, hrefEnd),
			titleRange,
		}
	};
}

function getFragmentRange(text: string, start: lsp.Position, end: lsp.Position): lsp.Range | undefined {
	const index = text.indexOf('#');
	if (index < 0) {
		return undefined;
	}
	return { start: translatePosition(start, { characterDelta: index + 1 }), end };
}

function getLinkSourceFragmentInfo(document: ITextDocument, link: string, linkStart: lsp.Position, linkEnd: lsp.Position): { hrefFragmentRange: lsp.Range | undefined; hrefPathText: string } {
	const fragmentRange = getFragmentRange(link, linkStart, linkEnd);
	return {
		hrefPathText: document.getText({ start: linkStart, end: fragmentRange ? translatePosition(fragmentRange.start, { characterDelta: -1 }) : linkEnd }),
		hrefFragmentRange: fragmentRange,
	};
}

const angleBracketLinkRe = /^<(.*)>$/;

/**
 * Used to strip brackets from the markdown link
 *
 * <http://example.com> will be transformed to http://example.com
*/
function stripAngleBrackets(link: string) {
	return link.replace(angleBracketLinkRe, '$1');
}

/**
 * Matches `[text](link)` or `[text](<link>)`
 */
const linkPattern = new RegExp(
	r`(?<!\\)` + // Must not start with escape

	// text
	r`(!?\[` + // open prefix match -->
	/**/r`(?:` +
	/*****/r`[^\[\]\\]|` + // Non-bracket chars, or...
	/*****/r`\\.|` + // Escaped char, or...
	/*****/r`\[[^\[\]]*\]` + // Matched bracket pair
	/**/r`)*` +
	r`\])` + // <-- close prefix match

	// Destination
	r`(\(\s*)` + // Pre href
	/**/r`(` +
	/*****/r`[^\s\(\)\<](?:[^\s\(\)]|\([^\s\(\)]*?\))*|` + // Link without whitespace, or...
	/*****/r`<(?:\\[<>]|[^<>])+>` + // In angle brackets
	/**/r`)` +

	// Title
	/**/r`\s*(?<title>"[^"]*"|'[^']*'|\([^\(\)]*\))?\s*` +
	r`\)`,
	'g');

/**
* Matches `[text][ref]` or `[shorthand]` or `[shorthand][]`
*/
const referenceLinkPattern = new RegExp(
	r`(?<![\]\\])` + // Must not start with another bracket
	r`(?:` +

	// [text][ref] or [text][]
	/**/r`(?<prefix>` + // Start link prefix
	/****/r`!?` + // Optional image ref
	/****/r`\[(?<text>(?:` +// Link text
	/******/r`\\.|` + // escaped character, or...
	/******/r`[^\[\]\\]|` + // non bracket char, or...
	/******/r`\[[^\[\]]*\]` + // matched bracket pair
	/****/`)*)\]` + // end link  text
	/****/r`\[\s*` + // Start of link def
	/**/r`)` + // end link prefix
	/**/r`(?<ref>(?:[^\\\]]|\\.)*?)\]` + // link def

	/**/r`|` +

	// [shorthand] but not [!shorthand]
	/****/r`\[(?!\!)\s*(?<shorthand>(?:\\.|[^\[\]\\])+?)\s*\]` +
	r`)` +
	r`(?![\(])`,  // Must not be followed by a paren to avoid matching normal links
	'gm');

/**
 * Matches `<http://example.com>`
 */
const autoLinkPattern = /(?<!\\)\<(\w+:[^\>\s]+)\>/g;

/**
 * Matches `[text]: link`
 */
const definitionPattern = /^([\t ]*(?<!\\)\[(?!\^)((?:\\\]|[^\]])+)\]:[\t ]*)([^<]\S*|<(?:\\[<>]|[^<>])+>)/gm;

class InlineRanges {

	public static create() {
		return new InlineRanges();
	}

	readonly #map: Map</* line number */ number, lsp.Range[]>;

	private constructor(data?: ReadonlyMap<number, lsp.Range[]>) {
		this.#map = new Map(data);
	}

	public get(line: number): lsp.Range[] {
		return this.#map.get(line) || [];
	}

	public add(range: lsp.Range): void {
		// Register the range for all lines that it covers
		for (let line = range.start.line; line <= range.end.line; line++) {
			let ranges = this.#map.get(line);
			if (!ranges) {
				ranges = [];
				this.#map.set(line, ranges);
			}
			ranges.push(range);
		}
	}

	public concat(newRanges: Iterable<lsp.Range>): InlineRanges {
		const result = new InlineRanges(this.#map);
		for (const range of newRanges) {
			result.add(range);
		}
		return result;
	}
}

const inlineCodePattern = /(?<!`)(`+)((?:.+?|.*?(?:(?:\r?\n).+?)*?)(?:\r?\n)?\1)(?!`)/gm;

class NoLinkRanges {
	public static compute(tokens: readonly Token[], document: ITextDocument): NoLinkRanges {
		const multiline = tokens
			.filter(t => (t.type === 'code_block' || t.type === 'fence' || t.type === 'html_block') && !!t.map)
			.map(t => ({ type: t.type, range: t.map as [number, number] }));

		const inlineRanges = InlineRanges.create();
		const text = document.getText();
		for (const match of text.matchAll(inlineCodePattern)) {
			const startOffset = match.index ?? 0;
			const startPosition = document.positionAt(startOffset);
			inlineRanges.add(lsp.Range.create(startPosition, document.positionAt(startOffset + match[0].length)));
		}

		return new NoLinkRanges(multiline, inlineRanges);
	}

	private constructor(
		/**
		 * Block element ranges, such as code blocks. Represented by [line_start, line_end).
		 */
		public readonly multiline: ReadonlyArray<{ type: string, range: [number, number] }>,

		/**
		 * Inline code spans where links should not be detected
		 */
		public readonly inline: InlineRanges,
	) { }

	contains(position: lsp.Position, excludeType = ''): boolean {
		return this.multiline.some(({ type, range }) => type !== excludeType && position.line >= range[0] && position.line < range[1]) ||
			!!this.inline.get(position.line)?.some(inlineRange => rangeContains(inlineRange, position));
	}

	concatInline(inlineRanges: Iterable<lsp.Range>): NoLinkRanges {
		return new NoLinkRanges(this.multiline, this.inline.concat(inlineRanges));
	}
}

/**
 * The place a document link links to.
 */
export type ResolvedDocumentLinkTarget =
	| { readonly kind: 'file'; readonly uri: URI; position?: lsp.Position; fragment?: string }
	| { readonly kind: 'folder'; readonly uri: URI }
	| { readonly kind: 'external'; readonly uri: URI };

/**
 * Stateless object that extracts link information from markdown files.
 */
export class MdLinkComputer {

	readonly #tokenizer: IMdParser;
	readonly #workspace: IWorkspace;

	constructor(
		tokenizer: IMdParser,
		workspace: IWorkspace,
	) {
		this.#tokenizer = tokenizer;
		this.#workspace = workspace;
	}

	public async getAllLinks(document: ITextDocument, token: lsp.CancellationToken): Promise<MdLink[]> {
		const tokens = await this.#tokenizer.tokenize(document);
		if (token.isCancellationRequested) {
			return [];
		}

		const noLinkRanges = NoLinkRanges.compute(tokens, document);

		const inlineLinks = Array.from(this.#getInlineLinks(document, noLinkRanges));
		return [
			...inlineLinks,
			...this.#getReferenceLinks(document, noLinkRanges.concatInline(inlineLinks.map(x => x.source.range))),
			...this.#getLinkDefinitions(document, noLinkRanges),
			...this.#getAutoLinks(document, noLinkRanges),
			...this.#getHtmlLinks(document, noLinkRanges),
		];
	}

	*#getInlineLinks(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const text = document.getText();
		for (const match of text.matchAll(linkPattern)) {
			const linkTextIncludingBrackets = match[1];
			const matchLinkData = createMdLink(document, linkTextIncludingBrackets, match[2], match[3], match.index ?? 0, match[0], match.groups?.['title'], this.#workspace);
			if (matchLinkData && !noLinkRanges.contains(matchLinkData.source.hrefRange.start)) {
				yield matchLinkData;

				// Also check for images in link text
				if (/\![\[\(]/.test(linkTextIncludingBrackets)) {
					const linkText = linkTextIncludingBrackets.slice(1, -1);
					const startOffset = (match.index ?? 0) + 1;
					for (const innerMatch of linkText.matchAll(linkPattern)) {
						const innerData = createMdLink(document, innerMatch[1], innerMatch[2], innerMatch[3], startOffset + (innerMatch.index ?? 0), innerMatch[0], innerMatch.groups?.['title'], this.#workspace);
						if (innerData) {
							yield innerData;
						}
					}

					yield* this.#getReferenceLinksInText(document, linkText, startOffset, noLinkRanges);
				}
			}
		}
	}

	*#getAutoLinks(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const text = document.getText();
		const docUri = getDocUri(document);
		for (const match of text.matchAll(autoLinkPattern)) {
			const linkOffset = (match.index ?? 0);
			const linkStart = document.positionAt(linkOffset);
			if (noLinkRanges.contains(linkStart)) {
				continue;
			}

			const link = match[1];
			const linkTarget = createHref(docUri, link, this.#workspace);
			if (linkTarget?.kind !== HrefKind.External) {
				continue;
			}

			const linkEnd = translatePosition(linkStart, { characterDelta: match[0].length });
			const hrefStart = translatePosition(linkStart, { characterDelta: 1 });
			const hrefEnd = translatePosition(hrefStart, { characterDelta: link.length });
			const hrefRange = { start: hrefStart, end: hrefEnd };
			yield {
				kind: MdLinkKind.AutoLink,
				href: linkTarget,
				source: {
					isAngleBracketLink: false,
					hrefText: link,
					resource: docUri,
					targetRange: hrefRange,
					hrefRange: hrefRange,
					range: { start: linkStart, end: linkEnd },
					...getLinkSourceFragmentInfo(document, link, hrefStart, hrefEnd),
					titleRange: undefined,
				}
			};
		}
	}

	#getReferenceLinks(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const text = document.getText();
		return this.#getReferenceLinksInText(document, text, 0, noLinkRanges);
	}

	*#getReferenceLinksInText(document: ITextDocument, text: string, startingOffset: number, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		for (const match of text.matchAll(referenceLinkPattern)) {
			if (!match.groups) {
				continue;
			}

			const linkStartOffset = startingOffset + (match.index ?? 0);
			const linkStart = document.positionAt(linkStartOffset);
			if (noLinkRanges.contains(linkStart)) {
				continue;
			}

			let hrefStart: lsp.Position;
			let hrefEnd: lsp.Position;
			let reference = match.groups['ref'];
			if (reference === '') { // [ref][],
				reference = match.groups['text'].trim();
				if (!reference) {
					continue;
				}
				const offset = linkStartOffset + 1;
				hrefStart = document.positionAt(offset);
				hrefEnd = document.positionAt(offset + reference.length);
			} else if (reference) { // [text][ref]
				const text = match.groups['text'];
				if (!text) {
					// Handle the case ![][cat]
					if (!match[0].startsWith('!')) {
						// Empty links are not valid
						continue;
					}
				}
				if (!match[0].startsWith('!')) {
					// Also get links in text
					yield* this.#getReferenceLinksInText(document, match[2], linkStartOffset + 1, noLinkRanges);
				}

				const pre = match[1];
				const offset = linkStartOffset + pre.length;
				hrefStart = document.positionAt(offset);
				hrefEnd = document.positionAt(offset + reference.length);
			} else if (match.groups['shorthand']) { // [ref]
				reference = match.groups['shorthand'].trim();
				if (!reference) {
					continue;
				}

				const offset = linkStartOffset + 1;
				hrefStart = document.positionAt(offset);
				const line = getLine(document, hrefStart.line);

				// See if link looks like link definition
				if (linkStart.character === 0 && line[match[0].length] === ':') {
					continue;
				}

				// See if link looks like a checkbox
				const checkboxMatch = line.match(/^\s*[\-\*\+]\s*\[x\]/i);
				if (checkboxMatch && hrefStart.character <= checkboxMatch[0].length) {
					continue;
				}

				hrefEnd = document.positionAt(offset + reference.length);
			} else {
				continue;
			}

			const linkEnd = translatePosition(linkStart, { characterDelta: match[0].length });
			yield {
				kind: MdLinkKind.Link,
				source: {
					isAngleBracketLink: false,
					hrefText: reference,
					hrefPathText: reference,
					resource: getDocUri(document),
					range: { start: linkStart, end: linkEnd },
					targetRange: lsp.Range.create(
						translatePosition(hrefStart, { characterDelta: -1 }),
						translatePosition(hrefEnd, { characterDelta: 1 })
					),
					hrefRange: lsp.Range.create(hrefStart, hrefEnd),
					hrefFragmentRange: undefined,
					titleRange: undefined, // TODO: support title
				},
				href: {
					kind: HrefKind.Reference,
					ref: reference,
				}
			};
		}
	}

	*#getLinkDefinitions(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLinkDefinition> {
		const text = document.getText();
		const docUri = getDocUri(document);
		for (const match of text.matchAll(definitionPattern)) {
			const offset = (match.index ?? 0);
			const linkStart = document.positionAt(offset);
			if (noLinkRanges.contains(linkStart)) {
				continue;
			}

			const pre = match[1];
			const reference = match[2];
			const rawLinkText = match[3].trim();
			const isAngleBracketLink = angleBracketLinkRe.test(rawLinkText);
			const linkText = stripAngleBrackets(rawLinkText);

			const target = createHref(docUri, linkText, this.#workspace);
			if (!target) {
				continue;
			}

			const hrefStart = translatePosition(linkStart, { characterDelta: pre.length + (isAngleBracketLink ? 1 : 0) });
			const hrefEnd = translatePosition(hrefStart, { characterDelta: linkText.length });
			const hrefRange = { start: hrefStart, end: hrefEnd };

			const refStart = translatePosition(linkStart, { characterDelta: 1 });
			const refRange: lsp.Range = { start: refStart, end: translatePosition(refStart, { characterDelta: reference.length }) };
			const line = getLine(document, linkStart.line);
			const linkEnd = translatePosition(linkStart, { characterDelta: line.length });
			yield {
				kind: MdLinkKind.Definition,
				source: {
					isAngleBracketLink,
					hrefText: linkText,
					resource: docUri,
					range: { start: linkStart, end: linkEnd },
					targetRange: hrefRange,
					hrefRange,
					...getLinkSourceFragmentInfo(document, rawLinkText, hrefStart, hrefEnd),
					titleRange: undefined, // TODO: support title
				},
				ref: { text: reference, range: refRange },
				href: target,
			};
		}
	}

	#getHtmlLinks(document: ITextDocument, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const text = document.getText();
		if (!/<\w/.test(text)) { // Only parse if there may be html
			return [];
		}

		try {
			const tree = parse(text);
			return this.#getHtmlLinksFromNode(document, tree, noLinkRanges);
		} catch {
			return [];
		}
	}

	static readonly #linkAttrsByTag = new Map(Array.from(htmlTagPathAttrs.entries(), ([key, value]) => [key, value.map(attr => {
		return { attr, regexp: new RegExp(`(${attr}=["'])([^'"]*)["']`, 'i') };
	})]));

	*#getHtmlLinksFromNode(document: ITextDocument, node: HTMLElement, noLinkRanges: NoLinkRanges): Iterable<MdLink> {
		const attrs = MdLinkComputer.#linkAttrsByTag.get(node.tagName);
		if (attrs) {
			for (const attr of attrs) {
				const link = node.attributes[attr.attr];
				if (!link) {
					continue;
				}

				const attrMatch = node.outerHTML.match(attr.regexp);
				if (!attrMatch) {
					continue;
				}

				const docUri = getDocUri(document);
				const linkTarget = createHref(docUri, link, this.#workspace);
				if (!linkTarget) {
					continue;
				}

				const linkStart = document.positionAt(node.range[0] + attrMatch.index! + attrMatch[1].length);
				if (noLinkRanges.contains(linkStart, 'html_block')) {
					continue;
				}

				const linkEnd = translatePosition(linkStart, { characterDelta: attrMatch[2].length });
				const hrefRange = { start: linkStart, end: linkEnd };
				yield {
					kind: MdLinkKind.Link,
					href: linkTarget,
					source: {
						isAngleBracketLink: false,
						hrefText: link,
						resource: docUri,
						targetRange: hrefRange,
						hrefRange: hrefRange,
						range: { start: linkStart, end: linkEnd },
						...getLinkSourceFragmentInfo(document, link, linkStart, linkEnd),
						titleRange: undefined,
					}
				};
			}
		}

		for (const child of node.childNodes) {
			if (child instanceof HTMLElement) {
				yield* this.#getHtmlLinksFromNode(document, child, noLinkRanges);
			}
		}
	}
}

export interface MdDocumentLinksInfo {
	readonly links: readonly MdLink[];
	readonly definitions: LinkDefinitionSet;
}

/**
 * Stateful object which provides links for markdown files the workspace.
 */
export class MdLinkProvider extends Disposable {

	readonly #linkCache: MdDocumentInfoCache<MdDocumentLinksInfo>;

	readonly #linkComputer: MdLinkComputer;
	readonly #config: LsConfiguration;
	readonly #workspace: IWorkspace;
	readonly #tocProvider: MdTableOfContentsProvider;
	readonly #logger: ILogger;

	constructor(
		config: LsConfiguration,
		tokenizer: IMdParser,
		workspace: IWorkspace,
		tocProvider: MdTableOfContentsProvider,
		logger: ILogger,
	) {
		super();

		this.#config = config;
		this.#workspace = workspace;
		this.#tocProvider = tocProvider;
		this.#logger = logger;

		this.#linkComputer = new MdLinkComputer(tokenizer, this.#workspace);
		this.#linkCache = this._register(new MdDocumentInfoCache(this.#workspace, (doc, token) => this.getLinksWithoutCaching(doc, token)));
	}

	public getLinks(document: ITextDocument): Promise<MdDocumentLinksInfo> {
		return this.#linkCache.getForDocument(document);
	}

	public async getLinksWithoutCaching(doc: ITextDocument, token: lsp.CancellationToken): Promise<MdDocumentLinksInfo> {
		this.#logger.log(LogLevel.Debug, 'LinkProvider.compute', { document: doc.uri, version: doc.version });

		const links = await this.#linkComputer.getAllLinks(doc, token);
		return {
			links,
			definitions: new LinkDefinitionSet(links),
		};
	}

	public async provideDocumentLinks(document: ITextDocument, token: lsp.CancellationToken): Promise<lsp.DocumentLink[]> {
		const { links, definitions } = await this.getLinks(document);
		if (token.isCancellationRequested) {
			return [];
		}

		return coalesce(links.map(data => this.#toValidDocumentLink(data, definitions)));
	}

	public async resolveDocumentLink(link: lsp.DocumentLink, token: lsp.CancellationToken): Promise<lsp.DocumentLink | undefined> {
		const href = this.#reviveLinkHrefData(link);
		if (!href) {
			return undefined;
		}

		const target = await this.#resolveInternalLinkTarget(href.path, href.fragment, token);
		switch (target.kind) {
			case 'folder':
				link.target = this.#createCommandUri('revealInExplorer', href.path);
				break;
			case 'external':
				link.target = target.uri.toString(true);
				break;
			case 'file':
				if (target.position) {
					link.target = this.#createOpenAtPosCommand(target.uri, target.position);
				} else {
					link.target = target.uri.toString(true);
				}
				break;
		}

		return link;
	}

	public async resolveLinkTarget(linkText: string, sourceDoc: URI, token: lsp.CancellationToken): Promise<ResolvedDocumentLinkTarget | undefined> {
		const href = createHref(sourceDoc, linkText, this.#workspace);
		if (href?.kind !== HrefKind.Internal) {
			return undefined;
		}

		const resolved = resolveInternalDocumentLink(sourceDoc, linkText, this.#workspace);
		if (!resolved) {
			return undefined;
		}

		return this.#resolveInternalLinkTarget(resolved.resource, resolved.linkFragment, token);
	}

	async #resolveInternalLinkTarget(linkPath: URI, linkFragment: string, token: lsp.CancellationToken): Promise<ResolvedDocumentLinkTarget> {
		let target = linkPath;

		// If there's a containing document, don't bother with trying to resolve the
		// link to a workspace file as one will not exist
		const containingContext = this.#workspace.getContainingDocument?.(target);
		if (!containingContext) {
			const stat = await this.#workspace.stat(target);
			if (stat?.isDirectory) {
				return { kind: 'folder', uri: target };
			}

			if (token.isCancellationRequested) {
				return { kind: 'folder', uri: target };
			}

			if (!stat) {
				// We don't think the file exists. If it doesn't already have an extension, try tacking on a `.md` and using that instead
				let found = false;
				const dotMdResource = tryAppendMarkdownFileExtension(this.#config, target);
				if (dotMdResource) {
					if (await this.#workspace.stat(dotMdResource)) {
						target = dotMdResource;
						found = true;
					}
				}

				if (!found) {
					return { kind: 'file', uri: target };
				}
			}
		}

		if (!linkFragment) {
			return { kind: 'file', uri: target };
		}

		// Try navigating with fragment that sets line number
		const locationLinkPosition = parseLocationInfoFromFragment(linkFragment);
		if (locationLinkPosition) {
			return { kind: 'file', uri: target, position: locationLinkPosition };
		}

		// Try navigating to header in file
		const doc = await this.#workspace.openMarkdownDocument(target);
		if (token.isCancellationRequested) {
			return { kind: 'file', uri: target };
		}

		if (doc) {
			const toc = await this.#tocProvider.getForContainingDoc(doc, token);
			const entry = toc.lookupByFragment(linkFragment);
			if (entry) {
				return { kind: 'file', uri: URI.parse(entry.headerLocation.uri), position: entry.headerLocation.range.start, fragment: linkFragment };
			}
		}

		return { kind: 'file', uri: target };
	}

	#reviveLinkHrefData(link: lsp.DocumentLink): { path: URI, fragment: string } | undefined {
		if (!link.data) {
			return undefined;
		}

		const mdLink = link.data as MdLink;
		if (mdLink.href.kind !== HrefKind.Internal) {
			return undefined;
		}

		return { path: URI.from(mdLink.href.path), fragment: mdLink.href.fragment };
	}

	#toValidDocumentLink(link: MdLink, definitionSet: LinkDefinitionSet): lsp.DocumentLink | undefined {
		switch (link.href.kind) {
			case HrefKind.External: {
				return {
					range: link.source.hrefRange,
					target: link.href.uri.toString(true),
				};
			}
			case HrefKind.Internal: {
				return {
					range: link.source.hrefRange,
					target: undefined, // Needs to be resolved later
					tooltip: l10n.t('Follow link'),
					data: link,
				};
			}
			case HrefKind.Reference: {
				// We only render reference links in the editor if they are actually defined.
				// This matches how reference links are rendered by markdown-it.
				const def = definitionSet.lookup(link.href.ref);
				if (!def) {
					return undefined;
				}

				const target = this.#createOpenAtPosCommand(link.source.resource, def.source.hrefRange.start);
				return {
					range: link.source.hrefRange,
					tooltip: l10n.t('Go to link definition'),
					target: target,
					data: link
				};
			}
		}
	}

	#createCommandUri(command: string, ...args: any[]): string {
		return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
	}

	#createOpenAtPosCommand(resource: URI, pos: lsp.Position): string {
		// If the resource itself already has a fragment, we need to handle opening specially 
		// instead of using `file://path.md#L123` style uris
		if (resource.fragment) {
			// Match the args of `vscode.open`
			return this.#createCommandUri('vscodeMarkdownLanguageservice.open', resource, {
				selection: lsp.Range.create(pos, pos),
			});
		}

		return resource.with({
			fragment: `L${pos.line + 1},${pos.character + 1}`
		}).toString(true);
	}
}

export function createWorkspaceLinkCache(
	parser: IMdParser,
	workspace: IWorkspace,
) {
	const linkComputer = new MdLinkComputer(parser, workspace);
	return new MdWorkspaceInfoCache(workspace, (doc, token) => linkComputer.getAllLinks(doc, token));
}
