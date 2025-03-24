# Changelog

## 0.5.0-alpha.9 — March 24
- Improved detection of multi-line links.

## 0.5.0-alpha.8 — October 29, 2024
- Fix incorrect detection of a multiline link definition #192
- Support spaces in angle brackets inside links: `[text](<#heading with spaces>)`
- Suppress diagnostics for `[!NOTE]` alert syntax.

## 0.5.0-alpha.7 — July 25, 2024
- Strip markup from header document symbols. This makes them more readable.

## 0.5.0-alpha.6 — April 25, 2024
- Clearly identify temporary versions of documents by setting version to `-1`. This lets clients know not to cache them.

## 0.5.0-alpha.5 — April 5, 2024
- Add links to open file in path completions.
- Add previews for image and video files in path completions.
- Allow hovering over image/video paths to see preview of image or video.

## 0.5.0-alpha.4 — April 4, 2024
- Change update links on paste to generate minimal edit.
- Update github slugifier to more closely match github.

## 0.5.0-alpha.3 — April 1, 2024
- Add experimental support for update links in text copied across Markdown files.

## 0.5.0-alpha.2 — March 28, 2024
- Fix renaming for cases where headers are duplicated.
- Give slugifiers control over how duplicate header ids are generated instead of hardcoding.

## 0.5.0-alpha.1 — March 11, 2024
- Fix lsp type references. Thanks @remcohaszing!
- Fix extracting of auto links.

## 0.4.0 — January 24, 2024
Highlights of previous alpha releases:

- Enable document links, references, and rename for HTML fragments in Markdown.
- Fix potential catastrophic backtracking in a regular expression.
- Avoid adding extra encoding on completions.
- Use fuzzy matching for workspace symbol search.
- Fix a number of cases around link detection / validation.

## 0.4.0-alpha.8 — October 31, 2023
- Fix potential catastrophic backtracking in a regular expression.
- Fix some false positives for link validation.

## 0.4.0-alpha.7 — September 25, 2023
- Fix path updates for angle bracket links with fragments.

## 0.4.0-alpha.6 — September 5, 2023
- Fix path completions when file name contains a literal `%`. In these cases the `%` needs to be encoded to prevent it from being incorrectly decoded on link click
- Fix more cases for link detection for links containing escaped characters.

## 0.4.0-alpha.5 — June 5, 2023
- Make rename and path completions escape angle brackets when inside of angle bracket links.
- On rename, try removing angle brackets from links if the link no longer requires it.
- Don't encode paths as aggressively on path completions.

## 0.4.0-alpha.4 — June 2, 2023
- Fix link detection for escaped angle brackets.

## 0.4.0-alpha.3 — May 30, 2023
- Fix extra escapes being added in angle bracket links on rename.
- Use angle brackets if new name name needs them on rename.

## 0.4.0-alpha.2 — May 23, 2023
- Add path completions in HTML attributes

## 0.4.0-alpha.1 — May 2, 2023
- Enable document links, references, and rename for HTML fragments in Markdown.

## 0.3.0 — March 16, 2023
- Enabled localization using `@vscode/l10n` package.
- Add support for cross workspace header completions when triggered on `##`.
- Add `preferredMdPathExtensionStyle` configuration option to control if generated paths to Markdown files should include or drop the file extension.
- Add folding of tables and block quotes.
- Clean up internal logging API.

## 0.3.0-alpha.6 — March 6, 2023
- Add folding of tables and block quotes.
- Clean up logging API.

## 0.3.0-alpha.5 — February 20, 2023
- Allow language service configuration to be changed dynamically. 

## 0.3.0-alpha.4 — February 1, 2023
- Add support for cross workspace header completions when triggered on `##`.
- Add `preferredMdPathExtensionStyle` configuration option to control if generated paths to Markdown files should include or drop the file extension.

## 0.3.0-alpha.3 — November 30, 2022
- Republish with missing types files.

## 0.3.0-alpha.2 — November 14, 2022
- Switch to `@vscode/l10n` for localization.

## 0.3.0-alpha.1 — November 4, 2022
- Added optional `$uri` property on `ITextDocument` which lets implementers provide an actual uri instead of a string. This helps reduce the number of calls to `URI.parse`.
- Workspace symbol search should be case insensitive.

## 0.2.0 — October 31, 2022
- Added diagnostics for unused link definitions.
- Added diagnostics for duplicated link definitions.
- Added quick fixes for removing duplicate / unused link definitions.
- Added document highlight provider.
- Polish Update links on file rename.
- Fix detection of reference link shorthand for names with spaces.
- Fix reference links references should be case in-sensitive.
- Fix reference links should resolve to first matching link definition.

## 0.1.0 — September 28, 2022
- Added `getCodeActions` to get code actions.
    - Added a code action to extract all occurrences of a link in a file to a link definition at the bottom.
- Added `organizeLinkDefinitions` which sorts link definitions to the bottom of the file and also optionally removes unused definitions.
- `getDocumentSymbols` now takes an optional `includeLinkDefinitions` option to also include link definitions in the document symbols.
- Added a `resolveLinkTarget` method which can be used to figure out where a link points based on its text and containing document.
- Make document links use more generic commands instead of internal VS Code commands.
- Fix document links within notebooks.
- Fix detection of image reference links.
- Use custom command name for triggering rename.
- Add `IPullDiagnosticsManager.disposeDocumentResources` to clean up watchers when a file is closed in the editor.
- Fix false positive diagnostic with files that link to themselves.
- Use parsed markdown to generate header slugs instead of using the original text.
- Make `getRenameFilesInWorkspaceEdit` return full sets of participating edits. 
- Bundle `d.ts` files using api-extractor.

## 0.0.1 — August 26, 2022
- Set explicit editor group when opening document links.

## 0.0.0 — August 16, 2022
- Initial beta release!
