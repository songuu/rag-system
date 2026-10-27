/** Only curated parser messages may cross the upload API boundary. */
export class EbookParseError extends Error {
  readonly code = 'EBOOK_PARSE_FAILED';
  readonly status = 400;
}
