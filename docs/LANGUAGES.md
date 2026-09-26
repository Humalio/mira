# Interface languages

The interface is offered in English (UK), Spanish (Spain), German, French, Portuguese (Portugal) and Italian. Browser preferences choose the initial language; a manual selection is saved on that device. Any other preference falls back to English (UK).

Catalogs ship inside the image. No translation server, account, API key, or additional runtime package is required. English keys are the source catalog; every catalog in `src/lib/i18n/messages/` must contain the same keys and interpolation placeholders, and the tests enforce this. New interface text must be added to each catalog.

## How much each catalog has been checked

English is the source, and Spanish has been offered beside it from the start. German, French, Portuguese and Italian were revised string by string against the English and the Spanish, with each string's use looked up in the code, but have not yet been read by a native speaker; corrections go straight into `src/lib/i18n/messages/<code>.json`, keeping keys and `{placeholders}` as they are. All four address the reader informally, as the Spanish does, and the Portuguese is European Portuguese.

## Adding or withdrawing a language

A catalog is offered only when its code is listed in `ENABLED_LOCALES` in `src/lib/i18n/index.ts`. A catalog that is in the repository but not listed is never served: it is missing from the language pickers, browser language detection skips it, and a device that chose it earlier gets its next preferred enabled language, or English. When changing the list, update the expected list in `src/lib/i18n/index.test.ts`, the first paragraph of this page and the changelog, then run `npm test`.

Application names, user-entered names and notes, and external source quotations keep their original text. Translating source material requires a separately labelled translation; a translated interface must never silently rewrite a quotation.
