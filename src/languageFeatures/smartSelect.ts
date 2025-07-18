/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as lsp from 'vscode-languageserver-protocol';
import { ILogger, LogLevel } from '../logging';
import { IMdParser, Token, TokenWithMap } from '../parser';
import { MdTableOfContentsProvider, TocEntry } from '../tableOfContents';
import { translatePosition } from '../types/position';
import { areRangesEqual, modifyRange, rangeContains } from '../types/range';
import { getLine, ITextDocument } from '../types/textDocument';
import { coalesce } from '../util/arrays';
import { isEmptyOrWhitespace } from '../util/string';
import { MdLinkProvider } from './documentLinks';
import { HrefKind, MdLinkKind } from '../types/documentLink';

export class MdSelectionRangeProvider {

	readonly #parser: IMdParser;
	readonly #tocProvider: MdTableOfContentsProvider;
	readonly #linkProvider: MdLinkProvider;

	readonly #logger: ILogger;

	constructor(
		parser: IMdParser,
		tocProvider: MdTableOfContentsProvider,
		documentLink: MdLinkProvider,
		logger: ILogger,
	) {
		this.#parser = parser;
		this.#tocProvider = tocProvider;
		this.#linkProvider = documentLink;
		this.#logger = logger;
	}

	public async provideSelectionRanges(document: ITextDocument, positions: readonly lsp.Position[], token: lsp.CancellationToken): Promise<lsp.SelectionRange[] | undefined> {
		this.#logger.log(LogLevel.Debug, 'MdSelectionRangeProvider.provideSelectionRanges', { document: document.uri, version: document.version });

		return coalesce(await Promise.all(positions.map(position => this.#provideSelectionRange(document, position, token))));
	}

	async #provideSelectionRange(document: ITextDocument, position: lsp.Position, token: lsp.CancellationToken): Promise<lsp.SelectionRange | undefined> {
		const headerRange = await this.#getHeaderSelectionRange(document, position, token);
		if (token.isCancellationRequested) {
			return;
		}

		const blockRange = await this.#getBlockSelectionRange(document, position, headerRange, token);
		if (token.isCancellationRequested) {
			return;
		}

		const inlineRange = await createInlineRange(document, position, blockRange, this.#linkProvider, token);
		if (token.isCancellationRequested) {
			return;
		}

		return inlineRange ?? blockRange ?? headerRange;
	}

	async #getBlockSelectionRange(document: ITextDocument, position: lsp.Position, parent: lsp.SelectionRange | undefined, token: lsp.CancellationToken): Promise<lsp.SelectionRange | undefined> {
		const tokens = await this.#parser.tokenize(document);
		if (token.isCancellationRequested) {
			return undefined;
		}

		const blockTokens = getBlockTokensForPosition(tokens, position, parent);
		if (blockTokens.length === 0) {
			return undefined;
		}

		let currentRange = parent ?? createBlockRange(blockTokens.shift()!, document, position.line, undefined);
		for (let i = 0; i < blockTokens.length; i++) {
			currentRange = createBlockRange(blockTokens[i], document, position.line, currentRange);
		}
		return currentRange;
	}

	async #getHeaderSelectionRange(document: ITextDocument, position: lsp.Position, token: lsp.CancellationToken): Promise<lsp.SelectionRange | undefined> {
		const toc = await this.#tocProvider.getForDocument(document);
		if (token.isCancellationRequested) {
			return undefined;
		}

		const headerInfo = getHeadersForPosition(toc.entries, position);
		const headers = headerInfo.headers;

		let currentRange: lsp.SelectionRange | undefined;
		for (let i = 0; i < headers.length; i++) {
			currentRange = createHeaderRange(headers[i], i === headers.length - 1, headerInfo.headerOnThisLine, currentRange, getFirstChildHeader(document, headers[i], toc.entries));
		}
		return currentRange;
	}
}

function getHeadersForPosition(toc: readonly TocEntry[], position: lsp.Position): { headers: TocEntry[]; headerOnThisLine: boolean } {
	const enclosingHeaders = toc.filter(header => header.sectionLocation.range.start.line <= position.line && header.sectionLocation.range.end.line >= position.line);
	const sortedHeaders = enclosingHeaders.sort((header1, header2) => (header1.line - position.line) - (header2.line - position.line));
	const onThisLine = toc.find(header => header.line === position.line) !== undefined;
	return {
		headers: sortedHeaders,
		headerOnThisLine: onThisLine
	};
}

function createHeaderRange(header: TocEntry, isClosestHeaderToPosition: boolean, onHeaderLine: boolean, parent?: lsp.SelectionRange, startOfChildRange?: lsp.Position): lsp.SelectionRange | undefined {
	const range = header.sectionLocation.range;
	const contentRange = lsp.Range.create(translatePosition(range.start, { lineDelta: 1 }), range.end);
	if (onHeaderLine && isClosestHeaderToPosition && startOfChildRange) {
		// selection was made on this header line, so select header and its content until the start of its first child
		// then all of its content
		return makeSelectionRange(modifyRange(range, undefined, startOfChildRange), makeSelectionRange(range, parent));
	} else if (onHeaderLine && isClosestHeaderToPosition) {
		// selection was made on this header line and no children so expand to all of its content
		return makeSelectionRange(range, parent);
	} else if (isClosestHeaderToPosition && startOfChildRange) {
		// selection was made within content and has child so select content
		// of this header then all content then header
		return makeSelectionRange(modifyRange(contentRange, undefined, startOfChildRange), makeSelectionRange(contentRange, (makeSelectionRange(range, parent))));
	} else {
		// not on this header line so select content then header
		return makeSelectionRange(contentRange, makeSelectionRange(range, parent));
	}
}

function getBlockTokensForPosition(tokens: readonly Token[], position: lsp.Position, parent: lsp.SelectionRange | undefined): TokenWithMap[] {
	const enclosingTokens = tokens.filter((token): token is TokenWithMap => !!token.map && (token.map[0] <= position.line && token.map[1] > position.line) && (!parent || (token.map[0] >= parent.range.start.line && token.map[1] <= parent.range.end.line + 1)) && isBlockElement(token));
	if (enclosingTokens.length === 0) {
		return [];
	}
	const sortedTokens = enclosingTokens.sort((token1, token2) => (token2.map[1] - token2.map[0]) - (token1.map[1] - token1.map[0]));
	return sortedTokens;
}

function createBlockRange(block: TokenWithMap, document: ITextDocument, cursorLine: number, parent: lsp.SelectionRange | undefined): lsp.SelectionRange {
	if (block.type === 'fence') {
		return createFencedRange(block, cursorLine, document, parent);
	}

	let startLine = isEmptyOrWhitespace(getLine(document, block.map[0])) ? block.map[0] + 1 : block.map[0];
	let endLine = startLine === block.map[1] ? block.map[1] : block.map[1] - 1;
	if (block.type === 'paragraph_open' && block.map[1] - block.map[0] === 2) {
		startLine = endLine = cursorLine;
	} else if (isList(block) && isEmptyOrWhitespace(getLine(document, endLine))) {
		endLine = endLine - 1;
	}
	const range = lsp.Range.create(startLine, 0, endLine, getLine(document, endLine).length);
	if (parent && rangeContains(parent.range, range) && !areRangesEqual(parent.range, range)) {
		return makeSelectionRange(range, parent);
	} else if (parent && areRangesEqual(parent.range, range)) {
		return parent;
	} else {
		return makeSelectionRange(range, undefined);
	}
}

async function createInlineRange(document: ITextDocument, cursorPosition: lsp.Position, parent: lsp.SelectionRange | undefined, linkProvider: MdLinkProvider, token: lsp.CancellationToken): Promise<lsp.SelectionRange | undefined> {
	const lineText = getLine(document, cursorPosition.line);
	const boldSelection = createBoldRange(lineText, cursorPosition.character, cursorPosition.line, parent);
	const italicSelection = createOtherInlineRange(lineText, cursorPosition.character, cursorPosition.line, true, parent);
	let comboSelection: lsp.SelectionRange | undefined;
	if (boldSelection && italicSelection && !areRangesEqual(boldSelection.range, italicSelection.range)) {
		if (rangeContains(boldSelection.range, italicSelection.range)) {
			comboSelection = createOtherInlineRange(lineText, cursorPosition.character, cursorPosition.line, true, boldSelection);
		} else if (rangeContains(italicSelection.range, boldSelection.range)) {
			comboSelection = createBoldRange(lineText, cursorPosition.character, cursorPosition.line, italicSelection);
		}
	}

	const linkSelection = await createLinkRange(document, cursorPosition, comboSelection ?? boldSelection ?? italicSelection ?? parent, linkProvider, token);
	if (token.isCancellationRequested) {
		return;
	}

	const inlineCodeBlockSelection = createOtherInlineRange(lineText, cursorPosition.character, cursorPosition.line, false, linkSelection ?? parent);
	return inlineCodeBlockSelection ?? linkSelection ?? comboSelection ?? boldSelection ?? italicSelection;
}

function createFencedRange(token: TokenWithMap, cursorLine: number, document: ITextDocument, parent?: lsp.SelectionRange): lsp.SelectionRange {
	const startLine = token.map[0];
	const endLine = token.map[1] - 1;
	const onFenceLine = cursorLine === startLine || cursorLine === endLine;
	const fenceRange = lsp.Range.create(startLine, 0, endLine, getLine(document, endLine).length);
	const contentRange = endLine - startLine > 2 && !onFenceLine ? lsp.Range.create(startLine + 1, 0, endLine - 1, getLine(document, endLine - 1).length) : undefined;
	if (contentRange) {
		return makeSelectionRange(contentRange, makeSelectionRange(fenceRange, parent));
	} else {
		if (parent && areRangesEqual(parent.range, fenceRange)) {
			return parent;
		} else {
			return makeSelectionRange(fenceRange, parent);
		}
	}
}

function createBoldRange(lineText: string, cursorChar: number, cursorLine: number, parent?: lsp.SelectionRange): lsp.SelectionRange | undefined {
	const regex = /\*\*([^*]+\*?[^*]+\*?[^*]+)\*\*/gim;
	const matches = [...lineText.matchAll(regex)].filter(match => lineText.indexOf(match[0]) <= cursorChar && lineText.indexOf(match[0]) + match[0].length >= cursorChar);
	if (matches.length) {
		// should only be one match, so select first and index 0 contains the entire match
		const bold = matches[0][0];
		const startIndex = lineText.indexOf(bold);
		const cursorOnStars = cursorChar === startIndex || cursorChar === startIndex + 1 || cursorChar === startIndex + bold.length || cursorChar === startIndex + bold.length - 1;
		const contentAndStars = makeSelectionRange(lsp.Range.create(cursorLine, startIndex, cursorLine, startIndex + bold.length), parent);
		const content = makeSelectionRange(lsp.Range.create(cursorLine, startIndex + 2, cursorLine, startIndex + bold.length - 2), contentAndStars);
		return cursorOnStars ? contentAndStars : content;
	}
	return undefined;
}

function createOtherInlineRange(lineText: string, cursorChar: number, cursorLine: number, isItalic: boolean, parent?: lsp.SelectionRange): lsp.SelectionRange | undefined {
	const italicRegexes = [/(?:[^*]+)(\*([^*]+)(?:\*\*[^*]*\*\*)*([^*]+)\*)(?:[^*]+)/g, /^(?:[^*]*)(\*([^*]+)(?:\*\*[^*]*\*\*)*([^*]+)\*)(?:[^*]*)$/g];
	let matches = [];
	if (isItalic) {
		matches = [...lineText.matchAll(italicRegexes[0])].filter(match => lineText.indexOf(match[0]) <= cursorChar && lineText.indexOf(match[0]) + match[0].length >= cursorChar);
		if (!matches.length) {
			matches = [...lineText.matchAll(italicRegexes[1])].filter(match => lineText.indexOf(match[0]) <= cursorChar && lineText.indexOf(match[0]) + match[0].length >= cursorChar);
		}
	} else {
		matches = [...lineText.matchAll(/\`[^\`]*\`/g)].filter(match => lineText.indexOf(match[0]) <= cursorChar && lineText.indexOf(match[0]) + match[0].length >= cursorChar);
	}
	if (matches.length) {
		// should only be one match, so select first and select group 1 for italics because that contains just the italic section
		// doesn't include the leading and trailing characters which are guaranteed to not be * so as not to be confused with bold
		const match = isItalic ? matches[0][1] : matches[0][0];
		const startIndex = lineText.indexOf(match);
		const cursorOnType = cursorChar === startIndex || cursorChar === startIndex + match.length;
		const contentAndType = makeSelectionRange(lsp.Range.create(cursorLine, startIndex, cursorLine, startIndex + match.length), parent);
		const content = makeSelectionRange(lsp.Range.create(cursorLine, startIndex + 1, cursorLine, startIndex + match.length - 1), contentAndType);
		return cursorOnType ? contentAndType : content;
	}
	return undefined;
}

async function createLinkRange(document: ITextDocument, cursorPos: lsp.Position, parent: lsp.SelectionRange | undefined, linkProvider: MdLinkProvider, token: lsp.CancellationToken): Promise<lsp.SelectionRange | undefined> {
	const allLinks = await linkProvider.getLinks(document);
	if (token.isCancellationRequested) {
		return;
	}

	const linksInRange = allLinks.links.filter(link => rangeContains(link.source.range, cursorPos));
	// For nested image links, the inner most list is returned last
	const link = linksInRange.at(-1);
	if (!link) {
		return;
	}

	if (link.kind === MdLinkKind.AutoLink) {
		return makeSelectionRange(link.source.hrefRange, makeSelectionRange(link.source.range, parent));
	}

	if (link.href.kind === HrefKind.Reference && areRangesEqual(link.source.targetRange, link.source.range)) {
		return makeSelectionRange(link.source.targetRange, parent);
	}

	const fullLinkSelectionRange = makeSelectionRange(link.source.range, parent);

	// determine if cursor is within [text] or (url) in order to know which should be selected
	if (rangeContains(link.source.targetRange, cursorPos)) {
		// Inside the href

		if (link.kind === MdLinkKind.Definition) {
			return makeSelectionRange(link.source.targetRange, fullLinkSelectionRange);
		}

		// Create two ranges, one for the href content and one for the content plus brackets
		const linkDestRanges = makeSelectionRange(
			lsp.Range.create(
				translatePosition(link.source.targetRange.start, { characterDelta: 1 }),
				translatePosition(link.source.targetRange.end, { characterDelta: -1 }),
			),
			makeSelectionRange(link.source.targetRange, fullLinkSelectionRange));

		if (link.source.titleRange) {
			// If we're inside the title, create a range for the title
			if (rangeContains(link.source.titleRange, cursorPos)) {
				return makeSelectionRange(link.source.titleRange, linkDestRanges);
			}
		}

		if (link.source.isAngleBracketLink) {
			// If we're inside an angle bracket link, create a range for the contents of the bracket and the brackets
			if (rangeContains(link.source.hrefRange, cursorPos)) {
				return makeSelectionRange(
					link.source.hrefRange,
					makeSelectionRange(
						lsp.Range.create(
							translatePosition(link.source.hrefRange.start, { characterDelta: -1 }),
							translatePosition(link.source.hrefRange.end, { characterDelta: 1 }),
						),
						linkDestRanges));
			}
		}

		if (link.source.titleRange) {
			// If we have a title but are not inside it, create an extra range just for the href too without the title
			return makeSelectionRange(link.source.hrefRange, linkDestRanges);
		}

		return linkDestRanges;
	} else {
		// Inside the text

		if (link.kind === MdLinkKind.Definition) {
			return makeSelectionRange(
				lsp.Range.create(
					translatePosition(link.source.range.start, { characterDelta: 1 }),
					translatePosition(link.source.targetRange.start, { characterDelta: -3 }), // TODO: Compute actual offset in cases where there is extra whitespace
				),
				fullLinkSelectionRange);
		}

		return makeSelectionRange(
			lsp.Range.create(
				translatePosition(link.source.range.start, { characterDelta: 1 }),
				translatePosition(link.source.targetRange.start, { characterDelta: -1 }),
			),
			fullLinkSelectionRange);
	}
}

function isList(token: Token): boolean {
	return token.type ? ['ordered_list_open', 'list_item_open', 'bullet_list_open'].includes(token.type) : false;
}

function isBlockElement(token: Token): boolean {
	return !['list_item_close', 'paragraph_close', 'bullet_list_close', 'inline', 'heading_close', 'heading_open'].includes(token.type);
}

function getFirstChildHeader(document: ITextDocument, header?: TocEntry, toc?: readonly TocEntry[]): lsp.Position | undefined {
	let childRange: lsp.Position | undefined;
	if (header && toc) {
		const children = toc.filter(t => rangeContains(header.sectionLocation.range, t.sectionLocation.range) && t.sectionLocation.range.start.line > header.sectionLocation.range.start.line).sort((t1, t2) => t1.line - t2.line);
		if (children.length > 0) {
			childRange = children[0].sectionLocation.range.start;
			const lineText = getLine(document, childRange.line - 1);
			return childRange ? translatePosition(childRange, { lineDelta: -1, characterDelta: lineText.length }) : undefined;
		}
	}
	return undefined;
}

function makeSelectionRange(range: lsp.Range, parent: lsp.SelectionRange | undefined): lsp.SelectionRange {
	if (parent && areRangesEqual(parent.range, range)) {
		return parent;
	}

	return { range, parent };
}
