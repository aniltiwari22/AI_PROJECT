const { extractPdfText } = require('./extractors/pdf');
const { extractDocxText } = require('./extractors/docx');
const { describeImage } = require('../config/ollama');

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const TEXT_TYPES = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yml', 'yaml', 'html']);
const OFFICE_TYPES = new Set(['docx', 'pptx']);

// Source files are plain text, but were rejected as "unknown" because they were
// never listed — so the assistant could not be shown a single line of code.
const CODE_TYPES = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'java', 'kt', 'go', 'rs',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'swift', 'scala',
  'sql', 'sh', 'bash', 'ps1', 'bat', 'css', 'scss', 'less', 'vue', 'svelte',
  'toml', 'ini', 'cfg', 'conf', 'env', 'gradle', 'dockerfile', 'makefile'
]);

const IMAGE_INSTRUCTION =
  'Read this image carefully. Transcribe all visible text exactly as it appears, ' +
  'preserving structure such as tables, labels and totals. ' +
  'After the transcription, add a short description of any charts, diagrams or photos. ' +
  'If the image contains no text, describe what it shows.';

function extensionOf(filename = '') {
  const match = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function detectKind(filename, mimeType = '') {
  const ext = extensionOf(filename);

  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (IMAGE_TYPES.has(ext) || mimeType.startsWith('image/')) return 'image';
  if (OFFICE_TYPES.has(ext)) return 'office';
  if (TEXT_TYPES.has(ext) || CODE_TYPES.has(ext) || mimeType.startsWith('text/')) return 'text';
  if (ext === 'doc') return 'legacy-doc';
  // Extensionless build files (Dockerfile, Makefile) still read as source.
  if (!ext && CODE_TYPES.has(String(filename).toLowerCase())) return 'text';
  return 'unknown';
}

/**
 * Extracts readable text from an uploaded buffer.
 * @returns {Promise<{ text, kind, warning?, meta? }>}
 */
async function extractContent({ buffer, filename, mimeType }) {
  const kind = detectKind(filename, mimeType);

  switch (kind) {
    case 'pdf': {
      const result = extractPdfText(buffer);
      return { kind, text: result.text, warning: result.warning, meta: { pages: result.pages } };
    }

    case 'office': {
      const result = extractDocxText(buffer);
      return { kind, text: result.text, warning: result.warning };
    }

    case 'image': {
      const text = await describeImage(buffer.toString('base64'), IMAGE_INSTRUCTION);
      return {
        kind,
        text: String(text).trim(),
        warning: String(text).trim() ? undefined : 'The vision model returned nothing for this image.'
      };
    }

    case 'text': {
      return { kind, text: buffer.toString('utf8').trim() };
    }

    case 'legacy-doc': {
      const error = new Error('Legacy .doc files are not supported. Please save the file as .docx and retry.');
      error.statusCode = 415;
      throw error;
    }

    default: {
      const error = new Error(
        `Unsupported file type "${extensionOf(filename) || mimeType || 'unknown'}". ` +
          'Supported: PDF, DOCX, PPTX, images (PNG/JPG/WEBP/GIF/BMP), source code, and plain text.'
      );
      error.statusCode = 415;
      throw error;
    }
  }
}

module.exports = { extractContent, detectKind };
