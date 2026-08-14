import { describe, expect, it } from 'vitest'
import { DEFAULT_MEDIA_TYPE, mediaTypeFor } from '../src/media-type.ts'

describe('mediaTypeFor', () => {
  it('recognizes the extensions a browser can render inline', () => {
    expect(mediaTypeFor('notes.txt')).toBe('text/plain')
    expect(mediaTypeFor('README.md')).toBe('text/markdown')
    expect(mediaTypeFor('rows.csv')).toBe('text/csv')
    expect(mediaTypeFor('config.json')).toBe('application/json')
    expect(mediaTypeFor('report.pdf')).toBe('application/pdf')
    expect(mediaTypeFor('photo.png')).toBe('image/png')
  })

  it('recognizes the office formats a user is most likely to upload', () => {
    expect(mediaTypeFor('年报.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(mediaTypeFor('预算.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(mediaTypeFor('提案.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  })

  it('matches the extension case-insensitively', () => {
    expect(mediaTypeFor('SCAN.PDF')).toBe('application/pdf')
    expect(mediaTypeFor('Photo.JPG')).toBe('image/jpeg')
  })

  it('falls back to the opaque default for an unrecognized or absent extension', () => {
    // The harness accepts every format, so an unknown extension is an ordinary
    // upload rather than a rejection: it is recorded opaquely and the agent
    // decides how to read it.
    expect(mediaTypeFor('model.safetensors')).toBe(DEFAULT_MEDIA_TYPE)
    expect(mediaTypeFor('Makefile')).toBe(DEFAULT_MEDIA_TYPE)
    expect(mediaTypeFor('archive.')).toBe(DEFAULT_MEDIA_TYPE)
  })

  it('reads only the final extension of a multi-part name', () => {
    expect(mediaTypeFor('backup.pdf.txt')).toBe('text/plain')
    expect(mediaTypeFor('data.json.gz')).toBe(DEFAULT_MEDIA_TYPE)
  })

  it('treats a dotfile as extensionless rather than reading its name as one', () => {
    // `.env`'s leading dot starts the stem, so there is no extension to match —
    // the alternative would report a media type derived from the whole name.
    expect(mediaTypeFor('.env')).toBe(DEFAULT_MEDIA_TYPE)
  })
})
