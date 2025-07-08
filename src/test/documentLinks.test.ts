/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as lsp from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';
import { getLsConfiguration } from '../config';
import { MdLinkComputer, MdLinkProvider } from '../languageFeatures/documentLinks';
import { MdTableOfContentsProvider } from '../tableOfContents';
import { InternalHref, MdLink } from '../types/documentLink';
import { InMemoryDocument } from '../types/inMemoryDocument';
import { noopToken } from '../util/cancellation';
import { ContainingDocumentContext, IWorkspace } from '../workspace';
import { createNewMarkdownEngine } from './engine';
import { InMemoryWorkspace } from './inMemoryWorkspace';
import { nulLogger } from './nulLogging';
import { assertRangeEqual, joinLines, workspacePath } from './util';


suite('Link computer', () => {

	function getLinksForText(fileContents: string): Promise<MdLink[]> {
		const doc = new InMemoryDocument(workspacePath('test.md'), fileContents);
		const workspace = new InMemoryWorkspace([doc]);
		return getLinks(doc, workspace);
	}

	function getLinks(doc: InMemoryDocument, workspace: IWorkspace): Promise<MdLink[]> {
		const engine = createNewMarkdownEngine();
		const linkProvider = new MdLinkComputer(engine, workspace);
		return linkProvider.getAllLinks(doc, noopToken);
	}

	function assertLinksEqual(actualLinks: readonly MdLink[], expected: ReadonlyArray<lsp.Range | { readonly range: lsp.Range; readonly sourceText: string }>) {
		assert.strictEqual(actualLinks.length, expected.length, 'Link counts should match');

		for (let i = 0; i < actualLinks.length; ++i) {
			const exp = expected[i];
			if ('range' in exp) {
				assertRangeEqual(actualLinks[i].source.hrefRange, exp.range, `Range ${i} to be equal`);
				assert.strictEqual(actualLinks[i].source.hrefText, exp.sourceText, `Source text ${i} to be equal`);
			} else {
				assertRangeEqual(actualLinks[i].source.hrefRange, exp, `Range ${i} to be equal`);
			}
		}
	}

	test('Should not return anything for empty document', async () => {
		const links = await getLinksForText('');
		assertLinksEqual(links, []);
	});

	test('Should not return anything for simple document without links', async () => {
		const links = await getLinksForText(joinLines(
			'# a',
			'fdasfdfsafsa',
		));
		assertLinksEqual(links, []);
	});

	test('Should detect basic http links', async () => {
		const links = await getLinksForText('a [b](https://example.com) c');
		assertLinksEqual(links, [
			lsp.Range.create(0, 6, 0, 25)
		]);
	});

	test('Should detect basic workspace links', async () => {
		{
			const links = await getLinksForText('a [b](./file) c');
			assertLinksEqual(links, [
				lsp.Range.create(0, 6, 0, 12)
			]);
		}
		{
			const links = await getLinksForText('a [b](file.png) c');
			assertLinksEqual(links, [
				lsp.Range.create(0, 6, 0, 14)
			]);
		}
	});

	test('Should detect links with title', async () => {
		const links = await getLinksForText('a [b](https://example.com "abc") c');
		assertLinksEqual(links, [
			lsp.Range.create(0, 6, 0, 25)
		]);
	});

	test('Should handle links with escaped characters in name (#35245)', async () => {
		const links = await getLinksForText('a [b\\]](./file)');
		assertLinksEqual(links, [
			lsp.Range.create(0, 8, 0, 14)
		]);
	});

	test('Should handle links with balanced parens', async () => {
		{
			const links = await getLinksForText('a [b](https://example.com/a()c) c');
			assertLinksEqual(links, [
				lsp.Range.create(0, 6, 0, 30)
			]);
		}
		{
			const links = await getLinksForText('a [b](https://example.com/a(b)c) c');
			assertLinksEqual(links, [
				lsp.Range.create(0, 6, 0, 31)
			]);
		}
		{
			// #49011
			const links = await getLinksForText('[A link](http://ThisUrlhasParens/A_link(in_parens))');
			assertLinksEqual(links, [
				lsp.Range.create(0, 9, 0, 50)
			]);
		}
	});

	test('Should ignore bracketed text inside link title (#150921)', async () => {
		{
			const links = await getLinksForText('[some [inner] in title](link)');
			assertLinksEqual(links, [
				lsp.Range.create(0, 24, 0, 28),
			]);
		}
		{
			const links = await getLinksForText('[some [inner] in title](<link>)');
			assertLinksEqual(links, [
				lsp.Range.create(0, 25, 0, 29),
			]);
		}
		{
			const links = await getLinksForText('[some [inner with space] in title](link)');
			assertLinksEqual(links, [
				lsp.Range.create(0, 35, 0, 39),
			]);
		}
		{
			const links = await getLinksForText(joinLines(
				`# h`,
				`[[a]](http://example.com)`,
			));
			assertLinksEqual(links, [
				lsp.Range.create(1, 6, 1, 24),
			]);
		}
	});

	test('Should handle two links without space', async () => {
		const links = await getLinksForText('a ([test](test)[test2](test2)) c');
		assertLinksEqual(links, [
			lsp.Range.create(0, 10, 0, 14),
			lsp.Range.create(0, 23, 0, 28)
		]);
	});

	test('should handle hyperlinked images (#49238)', async () => {
		{
			const links = await getLinksForText('[![alt text](image.jpg)](https://example.com)');
			assertLinksEqual(links, [
				lsp.Range.create(0, 25, 0, 44),
				lsp.Range.create(0, 13, 0, 22),
			]);
		}
		{
			const links = await getLinksForText('[![a]( whitespace.jpg )]( https://whitespace.com )');
			assertLinksEqual(links, [
				lsp.Range.create(0, 26, 0, 48),
				lsp.Range.create(0, 7, 0, 21),
			]);
		}
		{
			const links = await getLinksForText('[![a](img1.jpg)](file1.txt) text [![a](img2.jpg)](file2.txt)');
			assertLinksEqual(links, [
				lsp.Range.create(0, 17, 0, 26),
				lsp.Range.create(0, 6, 0, 14),
				lsp.Range.create(0, 50, 0, 59),
				lsp.Range.create(0, 39, 0, 47),
			]);
		}
	});

	test('Should not find empty reference link', async () => {
		{
			const links = await getLinksForText('[][]');
			assertLinksEqual(links, []);
		}
		{
			const links = await getLinksForText('[][cat]');
			assertLinksEqual(links, []);
		}
	});

	test('Should find image reference links', async () => {
		const links = await getLinksForText('![][cat]');
		assertLinksEqual(links, [
			lsp.Range.create(0, 4, 0, 7),
		]);
	});

	test('Should find inline image reference links', async () => {
		const links = await getLinksForText('ab ![][cat] d');
		assertLinksEqual(links, [
			lsp.Range.create(0, 7, 0, 10),
		]);
	});

	test('Should not consider link references starting with ^ character valid (#107471)', async () => {
		const links = await getLinksForText('[^reference]: https://example.com');
		assertLinksEqual(links, []);
	});

	test('Should find definitions links with spaces in angle brackets (#136073)', async () => {
		const links = await getLinksForText(joinLines(
			'[a]: <b c>',
			'[b]: <cd>',
		));

		assertLinksEqual(links, [
			{ range: lsp.Range.create(0, 6, 0, 9), sourceText: 'b c' },
			{ range: lsp.Range.create(1, 6, 1, 8), sourceText: 'cd' },
		]);
	});

	test('Should only find one link for definition (#141285)', async () => {
		const links = await getLinksForText(joinLines(
			'[Works]: https://example.com',
		));

		assertLinksEqual(links, [
			{ range: lsp.Range.create(0, 9, 0, 28), sourceText: 'https://example.com' },
		]);
	});

	test('Should find link with space in definition name', async () => {
		const links = await getLinksForText(joinLines(
			'[my ref]: https://example.com',
		));

		assertLinksEqual(links, [
			{ range: lsp.Range.create(0, 10, 0, 29), sourceText: 'https://example.com' },
		]);
	});

	test('Should find reference link shorthand (#141285)', async () => {
		const links = await getLinksForText(joinLines(
			'[ref]',
			'[ref]: https://example.com',
		));
		assertLinksEqual(links, [
			{ range: lsp.Range.create(0, 1, 0, 4), sourceText: 'ref' },
			{ range: lsp.Range.create(1, 7, 1, 26), sourceText: 'https://example.com' },
		]);
	});

	test('Should not find link for unclosed bracket ', async () => {
		const links = await getLinksForText(joinLines(
			`[unclosed`,
			``,
			`[ref]: https://example.com`,
		));
		assertLinksEqual(links, [
			{ range: lsp.Range.create(2, 7, 2, 26), sourceText: 'https://example.com' },
		]);
	});

	test('Should not find reference link shorthand when prefixed with ! (#164)', async () => {
		const links = await getLinksForText(joinLines(
			'[!note]',
			'[!anything]',
		));
		assertLinksEqual(links, []);
	});

	test('Should find reference link with space in reference name', async () => {
		const links = await getLinksForText(joinLines(
			'[text][my ref]',
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 7, 0, 13),
		]);
	});

	test('Should find reference link shorthand using empty closing brackets (#141285)', async () => {
		const links = await getLinksForText(joinLines(
			'[ref][]',
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 1, 0, 4),
		]);
	});

	test('Should find reference link shorthand using space in reference name', async () => {
		const links = await getLinksForText(joinLines(
			'[my ref][]',
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 1, 0, 7),
		]);
	});

	test('Should find reference link shorthand for link with space in label (#141285)', async () => {
		const links = await getLinksForText(joinLines(
			'[ref with space]',
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 1, 0, 15),
		]);
	});

	test('Should not include reference links with escaped leading brackets', async () => {
		const links = await getLinksForText(joinLines(
			`\\[bad link][good]`,
			`\\[good]`,
			`[good]: http://example.com`,
		));
		assertLinksEqual(links, [
			lsp.Range.create(2, 8, 2, 26) // Should only find the definition
		]);
	});

	test('Should not include links with escaped leading characters (#15)', async () => {
		const links = await getLinksForText(joinLines(
			`\\[text](http://example.com)`,
			`\\<http://example.com>`,
			``,
			`\\[def]: http://example.com`,
		));
		assertLinksEqual(links, []);
	});

	test('Should find angle bracket link in escaped link (#15)', async () => {
		// Somewhat contrived example, but it's valid markdown and the auto links should be found
		const links = await getLinksForText(joinLines(
			`\\[text](<http://example.com>)`,
			``,
			`\\[text]: <http://example.com>`,
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 9, 0, 27),
			lsp.Range.create(2, 10, 2, 28),
		]);
	});

	test('Should not consider links in code fenced with backticks', async () => {
		const links = await getLinksForText(joinLines(
			'```',
			'[b](https://example.com)',
			'```'));
		assertLinksEqual(links, []);
	});

	test('Should not consider links in code fenced with tilde', async () => {
		const links = await getLinksForText(joinLines(
			'~~~',
			'[b](https://example.com)',
			'~~~'));
		assertLinksEqual(links, []);
	});

	test('Should not consider links in indented code', async () => {
		const links = await getLinksForText('    [b](https://example.com)');
		assertLinksEqual(links, []);
	});

	test('Should not consider links in inline code span', async () => {
		const links = await getLinksForText('`[b](https://example.com)`');
		assertLinksEqual(links, []);
	});

	test('Should not consider links with code span inside', async () => {
		const links = await getLinksForText('[li`nk](https://example.com`)');
		assertLinksEqual(links, []);
	});

	test('Should not consider links in multiline inline code span', async () => {
		const links = await getLinksForText(joinLines(
			'`` ',
			'[b](https://example.com)',
			'``'));
		assertLinksEqual(links, []);
	});

	test('Should not consider link references in code fenced with backticks (#146714)', async () => {
		const links = await getLinksForText(joinLines(
			'```',
			'[a] [bb]',
			'```'));
		assertLinksEqual(links, []);
	});

	test('Should not consider reference sources in code fenced with backticks (#146714)', async () => {
		const links = await getLinksForText(joinLines(
			'```',
			'[a]: http://example.com;',
			'[b]: <http://example.com>;',
			'[c]: (http://example.com);',
			'```'));
		assertLinksEqual(links, []);
	});

	test('Should not consider links in multiline inline code span between between text', async () => {
		const links = await getLinksForText(joinLines(
			'[b](https://1.com) `[b](https://2.com)',
			'[b](https://3.com) ` [b](https://4.com)'));

		assertLinksEqual(links, [
			lsp.Range.create(0, 4, 0, 17),
			lsp.Range.create(1, 25, 1, 38),
		]);
	});

	test('Should not consider links in multiline inline code span with new line after the first backtick', async () => {
		const links = await getLinksForText(joinLines(
			'`',
			'[b](https://example.com)`'));
		assertLinksEqual(links, []);
	});

	test('Should not miss links in invalid multiline inline code span', async () => {
		const links = await getLinksForText(joinLines(
			'`` ',
			'',
			'[b](https://example.com)',
			'',
			'``'));
		assertLinksEqual(links, [
			lsp.Range.create(2, 4, 2, 23)
		]);
	});

	test('Should find autolinks', async () => {
		const links = await getLinksForText('pre <http://example.com> post');
		assertLinksEqual(links, [
			lsp.Range.create(0, 5, 0, 23)
		]);
	});

	test('Should not detect links inside html comment blocks', async () => {
		const links = await getLinksForText(joinLines(
			`<!-- <http://example.com> -->`,
			`<!-- [text](./foo.md) -->`,
			`<!-- [text]: ./foo.md -->`,
			``,
			`<!--`,
			`<http://example.com>`,
			`-->`,
			``,
			`<!--`,
			`[text](./foo.md)`,
			`-->`,
			``,
			`<!--`,
			`[text]: ./foo.md`,
			`-->`,
		));
		assertLinksEqual(links, []);
	});

	test.skip('Should not detect links inside inline html comments', async () => {
		// See #149678
		const links = await getLinksForText(joinLines(
			`text <!-- <http://example.com> --> text`,
			`text <!-- [text](./foo.md) --> text`,
			`text <!-- [text]: ./foo.md --> text`,
			``,
			`text <!--`,
			`<http://example.com>`,
			`--> text`,
			``,
			`text <!--`,
			`[text](./foo.md)`,
			`--> text`,
			``,
			`text <!--`,
			`[text]: ./foo.md`,
			`--> text`,
		));
		assertLinksEqual(links, []);
	});

	test('Should not mark checkboxes as links', async () => {
		const links = await getLinksForText(joinLines(
			'- [x]',
			'- [X]',
			'- [ ]',
			'* [x]',
			'* [X]',
			'* [ ]',
			``,
			`[x]: http://example.com`
		));
		assertLinksEqual(links, [
			lsp.Range.create(7, 5, 7, 23)
		]);
	});

	test('Should still find links on line with checkbox', async () => {
		const links = await getLinksForText(joinLines(
			'- [x] [x]',
			'- [X] [x]',
			'- [] [x]',
			``,
			`[x]: http://example.com`
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 7, 0, 8),
			lsp.Range.create(1, 7, 1, 8),
			lsp.Range.create(2, 6, 2, 7),
			lsp.Range.create(4, 5, 4, 23),
		]);
	});

	test('Should find link only within angle brackets', async () => {
		const links = await getLinksForText(joinLines(
			`[link](<path>)`
		));
		assertLinksEqual(links, [lsp.Range.create(0, 8, 0, 12)]);
	});

	test('Should find link within angle brackets even with link title', async () => {
		const links = await getLinksForText(joinLines(
			`[link](<path> "test title")`
		));
		assertLinksEqual(links, [lsp.Range.create(0, 8, 0, 12)]);
	});

	test('Should find link within angle brackets even with surrounding spaces', async () => {
		const links = await getLinksForText(joinLines(
			`[link]( <path> )`
		));
		assertLinksEqual(links, [lsp.Range.create(0, 9, 0, 13)]);
	});

	test('Should find link within angle brackets for image hyperlinks', async () => {
		const links = await getLinksForText(joinLines(
			`![link](<path>)`
		));
		assertLinksEqual(links, [lsp.Range.create(0, 9, 0, 13)]);
	});

	test('Should find link with spaces in angle brackets for image hyperlinks with titles', async () => {
		const links = await getLinksForText(joinLines(
			`![link](< path > "test")`
		));
		assertLinksEqual(links, [lsp.Range.create(0, 9, 0, 15)]);
	});


	test('Should not find link due to incorrect angle bracket notation or usage', async () => {
		const links = await getLinksForText(joinLines(
			`[link](<path )`,
			`[link](<> path>)`,
			`[link](> path)`,
		));
		assertLinksEqual(links, []);
	});

	test('Should find link within angle brackets even with space inside link', async () => {
		const links = await getLinksForText(joinLines(
			`[link](<pa th>)`
		));

		assertLinksEqual(links, [lsp.Range.create(0, 8, 0, 13)]);
	});

	test('Should find link within angle brackets with spaces in fragment', async () => {
		const links = await getLinksForText(joinLines(
			`[link](<pa th#fr agment>)`
		));

		assertLinksEqual(links, [lsp.Range.create(0, 8, 0, 23)]);
	});

	test('Should find links with titles', async () => {
		const links = await getLinksForText(joinLines(
			`[link](<no such.md> "text")`,
			`[link](<no such.md> 'text')`,
			`[link](<no such.md> (text))`,
			`[link](no-such.md "text")`,
			`[link](no-such.md 'text')`,
			`[link](no-such.md (text))`,
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 8, 0, 18),
			lsp.Range.create(1, 8, 1, 18),
			lsp.Range.create(2, 8, 2, 18),
			lsp.Range.create(3, 7, 3, 17),
			lsp.Range.create(4, 7, 4, 17),
			lsp.Range.create(5, 7, 5, 17),
		]);
	});

	test('Should not include link with empty angle bracket', async () => {
		const links = await getLinksForText(joinLines(
			`[](<>)`,
			`[link](<>)`,
			`[link](<> "text")`,
			`[link](<> 'text')`,
			`[link](<> (text))`,
		));
		assertLinksEqual(links, []);
	});

	test('Should return uri of inner document', async () => {
		const subScheme = 'sub-doc';
		const parentUri = workspacePath('test.md');
		const docUri = parentUri.with({
			scheme: subScheme,
			fragment: 'abc',
		});

		const doc = new InMemoryDocument(docUri, joinLines(
			`# Header`,
			`[abc](#header)`,
		));

		const workspace = new class extends InMemoryWorkspace {
			constructor() {
				super([doc]);
			}

			getContainingDocument(resource: URI): ContainingDocumentContext | undefined {
				if (resource.scheme === 'sub-doc') {
					return {
						uri: resource.with({ scheme: parentUri.scheme }),
						children: [],
					};
				}
				return undefined;
			}
		};

		const links = await getLinks(doc, workspace);
		assert.strictEqual(links.length, 1);

		const link = links[0];
		assert.strictEqual((link.href as InternalHref).path.toString(), docUri.toString());
	});

	test(`Should allow links to end with ':' if they are not link defs (https://github.com/microsoft/vscode/issues/162691)`, async () => {
		const links = await getLinksForText(joinLines(
			`- [@just-web/contributions]: abc`,
			`- [@just-web/contributions]:`,
			`- [@just-web/contributions][]:`,
			`- [@just-web/contributions][ref]:`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 3, 0, 26),
			lsp.Range.create(1, 3, 1, 26),
			lsp.Range.create(2, 3, 2, 26),
			lsp.Range.create(3, 28, 3, 31),
		]);
	});

	test(`Should handle reference links with backticks`, async () => {
		const links = await getLinksForText(joinLines(
			'[`github`][github]',
			``,
			`[github]: https://github.com`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 11, 0, 17),
			lsp.Range.create(2, 10, 2, 28),
		]);
	});

	test('Should find reference links to images', async () => {
		const links = await getLinksForText(joinLines(
			`[![alt](img)][def]`,
			``,
			`[def]: http://example.com`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 8, 0, 11),
			lsp.Range.create(0, 14, 0, 17),
			lsp.Range.create(2, 7, 2, 25),
		]);
	});

	test('Should find links to images references', async () => {
		const links = await getLinksForText(joinLines(
			`[![alt][def]](img)`,
			``,
			`[def]: http://example.com`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 14, 0, 17),
			lsp.Range.create(0, 8, 0, 11),
			lsp.Range.create(2, 7, 2, 25),
		]);
	});

	test('Should find reference links to image references', async () => {
		const links = await getLinksForText(joinLines(
			`[![alt][img]][def]`,
			``,
			`[def]: http://example.com`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 8, 0, 11),
			lsp.Range.create(0, 14, 0, 17),
			lsp.Range.create(2, 7, 2, 25),
		]);
	});

	test('Should find reference link with nested brackets', async () => {
		const links = await getLinksForText(joinLines(
			`[[test]]`,
			``,
			`[test]: http://example.com`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 2, 0, 6),
			lsp.Range.create(2, 8, 2, 26),
		]);
	});

	test('Should find reference link with escaped brackets', async () => {
		const links = await getLinksForText(joinLines(
			String.raw`[some text][\[test\]]`,
			String.raw`[\[test\]][]`,
			String.raw`[\[test\]]`,
			String.raw``,
			String.raw`[\[test\]]: http://example.com`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 12, 0, 20),
			lsp.Range.create(1, 1, 1, 9),
			lsp.Range.create(2, 1, 2, 9),
			lsp.Range.create(4, 12, 4, 30),
		]);
	});

	test('Should find src in block html <img>', async () => {
		const links = await getLinksForText(joinLines(
			`<img src="cat.png">`,
			``,
			`<img src='cat.png'>`,
			``,
			`<img src='cat.png' />`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 10, 0, 17),
			lsp.Range.create(2, 10, 2, 17),
			lsp.Range.create(4, 10, 4, 17),
		]);
	});

	test('Should find src in inline html <img>', async () => {
		const links = await getLinksForText(joinLines(
			`text <img src="cat.png"> more text`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 15, 0, 22),
		]);
	});

	test('Should ignore html link in code block', async () => {
		const links = await getLinksForText(joinLines(
			`inline \`<img src="cat.png">\``,
			``,
			`~~~`,
			`<img src="cat.png">`,
			`~~~`
		));

		assertLinksEqual(links, []);
	});

	test('Should find angle bracket links with escapes', async () => {
		const links = await getLinksForText(joinLines(
			String.raw`![text](<\<cat\>.gif>)`,
			String.raw``,
			String.raw`[def]: <\<cat\>.gif>`
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 9, 0, 20),
			lsp.Range.create(2, 8, 2, 19),
		]);
	});

	test('Should not find reference links in inline code (#153)', async () => {
		const links = await getLinksForText(joinLines(
			'- `[!xyz].js` `ab.js` `[^xyz].js` `[!x-z].js`。',
		));

		assertLinksEqual(links, []);
	});

	test('Should not catastrophical backtrack on slashes', async () => {
		const links = await getLinksForText(joinLines(
			`# symbol`,
			String.raw`[\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\`,
		));

		assertLinksEqual(links, []);
	});

	test('Should not crash on definition that spans multiple lines (#192)', async () => {
		const links = await getLinksForText(joinLines(
			`Options`,
			`[positional parameters]:`,
			`-R: recursively list subdirectories.`,
		));

		assertLinksEqual(links, []);
	});

	test('Should find multi-line links', async () => {
		const links = await getLinksForText(joinLines(
			`[te`,
			`xt](foo.md)`,
			`[te`,
			`xt](foo.md#abc 'text')`,
			`[te`,
			`xt](<foo.md#abc>)`,
			``,
			`[`,
			`text`,
			`](`,
			`foo.md`,
			`)`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(1, 4, 1, 10),
			lsp.Range.create(3, 4, 3, 14),
			lsp.Range.create(5, 5, 5, 15),
			lsp.Range.create(10, 0, 10, 6),
		]);
	});
});


suite('Link provider', () => {

	const testFile = workspacePath('x.md');

	function getLinksForFile(fileContents: string) {
		const doc = new InMemoryDocument(testFile, fileContents);
		const workspace = new InMemoryWorkspace([doc]);

		const engine = createNewMarkdownEngine();
		const tocProvider = new MdTableOfContentsProvider(engine, workspace, nulLogger);
		const provider = new MdLinkProvider(getLsConfiguration({}), engine, workspace, tocProvider, nulLogger);
		return provider.provideDocumentLinks(doc, noopToken);
	}

	function assertLinksEqual(actualLinks: readonly lsp.DocumentLink[], expectedRanges: readonly lsp.Range[]) {
		assert.strictEqual(actualLinks.length, expectedRanges.length);

		for (let i = 0; i < actualLinks.length; ++i) {
			assertRangeEqual(actualLinks[i].range, expectedRanges[i], `Range ${i} to be equal`);
		}
	}

	test('Should include defined reference links (#141285)', async () => {
		const links = await getLinksForFile(joinLines(
			'[ref]',
			'[ref][]',
			'[ref][ref]',
			'',
			'[ref]: http://example.com'
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 1, 0, 4),
			lsp.Range.create(1, 1, 1, 4),
			lsp.Range.create(2, 6, 2, 9),
			lsp.Range.create(4, 7, 4, 25),
		]);
	});

	test('Should not include reference link shorthand when definition does not exist (#141285)', async () => {
		const links = await getLinksForFile('[ref]');
		assertLinksEqual(links, []);
	});

	test('Should find reference links case insensitively', async () => {
		const links = await getLinksForFile(joinLines(
			'[ref]',
			'[rEf][]',
			'[ref][ReF]',
			'',
			'[REF]: http://example.com'
		));
		assertLinksEqual(links, [
			lsp.Range.create(0, 1, 0, 4),
			lsp.Range.create(1, 1, 1, 4),
			lsp.Range.create(2, 6, 2, 9),
			lsp.Range.create(4, 7, 4, 25),
		]);
	});

	test('Should use first link reference found in document', async () => {
		const links = await getLinksForFile(joinLines(
			`[abc]`,
			``,
			`[abc]: http://example.com/1`,
			`[abc]: http://example.com/2`,
		));

		assertLinksEqual(links, [
			lsp.Range.create(0, 1, 0, 4),
			lsp.Range.create(2, 7, 2, 27),
			lsp.Range.create(3, 7, 3, 27),
		]);

		assert.strictEqual(links[0].target, testFile.with({ fragment: 'L3,8' }).toString(true));
	});

	test('Should not encode link', async () => {
		const exampleUrl = 'http://example/%A5%C8';
		const links = await getLinksForFile(joinLines(
			`[link](${exampleUrl})`
		));
		assert.strictEqual(links[0].target, exampleUrl);
	});
});
