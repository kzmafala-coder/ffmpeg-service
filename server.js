/**
 * Quiz FFmpeg Render Service
 * -------------------------------------------------------------
 * Overlays a dynamic question + 4 answers onto a pre-designed
 * vertical 1080x1920 video template using FFmpeg drawtext.
 *
 * The template already contains: background, question frame, four
 * answer frames, the A: B: C: D: letters, animation and sound.
 * This service ONLY draws the dynamic text, centered on fixed
 * coordinates. It never changes the design, frame positions or sizes.
 *
 * Endpoint:  POST /render   (multipart/form-data)
 *   - video : the template video file (binary)             [required]
 *   - payload : JSON string with question + answers + timing [required]
 *   Alternatively the same fields can be sent flat as form fields.
 *
 * Response: the rendered MP4 as a binary download.
 * -------------------------------------------------------------
 */

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const opentype = require('opentype.js');

const app = express();
app.use(express.json({ limit: '50mb' }));

const upload = multer({ dest: os.tmpdir() });

// ------------------------------------------------------------------
// Fixed template geometry (from spec). DO NOT change these numbers —
// they are the base geometry of the template.
// Coordinates are the CENTER point of each text block.
// ------------------------------------------------------------------
const GEOMETRY = {
  video: { width: 1080, height: 1920 },
  question: { x: 540, y: 484, max_width: 800, font_size: 56, min_font_size: 42, max_lines: 3 },
  answers: {
    A: { x: 567, y: 829, max_width: 440, font_size: 36, min_font_size: 28, max_lines: 1 },
    B: { x: 567, y: 1006, max_width: 440, font_size: 36, min_font_size: 28, max_lines: 1 },
    C: { x: 567, y: 1179, max_width: 440, font_size: 36, min_font_size: 28, max_lines: 1 },
    D: { x: 567, y: 1361, max_width: 440, font_size: 36, min_font_size: 28, max_lines: 1 },
  },
  // Explanation block. Defaults are centered on screen; override per
  // request via payload fields (explanation_x, explanation_y,
  // explanation_max_width, explanation_font_size, explanation_min_font_size,
  // explanation_max_lines) or the EXPL_* env vars.
  explanation: {
    x: Number(process.env.EXPL_X || 540),
    y: Number(process.env.EXPL_Y || 960),
    max_width: Number(process.env.EXPL_MAX_WIDTH || 880),
    font_size: Number(process.env.EXPL_FONT_SIZE || 44),
    min_font_size: Number(process.env.EXPL_MIN_FONT_SIZE || 32),
    max_lines: Number(process.env.EXPL_MAX_LINES || 5),
  },
};

// Default timeline (seconds) for a ~32s clip. Any of these can be
// overridden by the matching payload field from n8n.
const DEFAULT_TIMING = {
  question_start: 3, question_end: 29,
  answers_start: 3,
  wrong_answers_end: 25,   // wrong answers disappear
  correct_answer_end: 29,  // correct answer stays, then removed
  explanation_start: 29, explanation_end: 32,
};

// Font with full Cyrillic support. Ship a .ttf next to this file.
const FONT_PATH = process.env.FONT_PATH || path.join(__dirname, 'fonts', 'NotoSans-Bold.ttf');
const LINE_SPACING = 1.15; // multiplier of font size between wrapped lines

// Load font once for text-measurement (word wrapping / autosize).
let FONT = null;
try {
  FONT = opentype.loadSync(FONT_PATH);
} catch (e) {
  console.error(`[WARN] Could not load font for measuring at ${FONT_PATH}: ${e.message}`);
  console.error('       Text wrapping/autosize will fall back to an estimate.');
}

// ---- text measuring helpers --------------------------------------

function measureWidth(text, fontSize) {
  if (FONT) {
    try {
      return FONT.getAdvanceWidth(text, fontSize);
    } catch (_) {
      /* fall through to estimate */
    }
  }
  // Rough fallback: average glyph width ~0.55em
  return text.length * fontSize * 0.55;
}

/**
 * Wrap `text` into lines that each fit within maxWidth at fontSize.
 * Returns null if a single word cannot fit even on its own line.
 */
function wrapText(text, fontSize, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureWidth(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // Word alone too wide?
      if (measureWidth(word, fontSize) > maxWidth) return null;
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Find the largest font size (between min and max) that fits `text`
 * inside maxWidth within maxLines. Returns { fontSize, lines } or
 * null if it cannot fit even at min font size.
 */
function fitText(text, { font_size, min_font_size, max_width, max_lines }) {
  for (let size = font_size; size >= min_font_size; size--) {
    const lines = wrapText(text, size, max_width);
    if (lines && lines.length <= max_lines) {
      return { fontSize: size, lines };
    }
  }
  return null;
}

// ---- ffmpeg drawtext builder -------------------------------------

// Escape text for ffmpeg drawtext (we pass text via textfile to avoid
// most escaping issues, but keep this for inline safety if needed).
function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

/**
 * Build drawtext filter entries for a centered multi-line text block.
 * centerX / centerY are the geometric center of the whole block.
 * enable is an optional ffmpeg between(t,...) expression for timing.
 */
function buildBlockFilters(lines, fontSize, centerX, centerY, tmpDir, tag, enableExpr) {
  const lineHeight = fontSize * LINE_SPACING;
  const totalHeight = lineHeight * lines.length;
  const filters = [];
  lines.forEach((line, i) => {
    // textfile per line to avoid escaping/encoding pitfalls with Cyrillic
    const tf = path.join(tmpDir, `txt_${tag}_${i}.txt`);
    fs.writeFileSync(tf, line, 'utf8');
    // y of this line's top-left so the block is vertically centered on centerY
    const lineTopY = centerY - totalHeight / 2 + i * lineHeight;
    const parts = [
      `fontfile='${FONT_PATH.replace(/\\/g, '/').replace(/:/g, '\\:')}'`,
      `textfile='${tf.replace(/\\/g, '/').replace(/:/g, '\\:')}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${process.env.FONT_COLOR || 'white'}`,
      // horizontal center on centerX; (w-text_w)/2 would center on screen,
      // so we anchor to centerX explicitly:
      `x=${centerX}-(text_w/2)`,
      `y=${Math.round(lineTopY)}`,
    ];
    if (enableExpr) parts.push(`enable='${enableExpr}'`);
    filters.push(`drawtext=${parts.join(':')}`);
  });
  return filters;
}

// Build an ffmpeg between() timing expression, or null if not provided.
function timingExpr(start, end) {
  const s = Number(start);
  const e = Number(end);
  if (Number.isFinite(s) && Number.isFinite(e)) {
    return `between(t,${s},${e})`;
  }
  return null;
}

// ---- request normalization ---------------------------------------

function extractData(req) {
  // Accept either a JSON `payload` field or flat fields.
  let data = {};
  if (req.body && req.body.payload) {
    try {
      data = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload;
    } catch (e) {
      throw new Error('INVALID_PAYLOAD_JSON');
    }
  } else {
    data = req.body || {};
  }

  const question = data.question;
  // Support both A/B/C/D fields and an answers array.
  let answers = {};
  if (Array.isArray(data.answers)) {
    ['A', 'B', 'C', 'D'].forEach((k, i) => { answers[k] = data.answers[i]; });
  } else {
    answers = {
      A: data.answer_A ?? data.answerA,
      B: data.answer_B ?? data.answerB,
      C: data.answer_C ?? data.answerC,
      D: data.answer_D ?? data.answerD,
    };
  }

  const explanation = data.explanation ?? null;

  // Determine the correct answer letter (A/B/C/D).
  // Accept either a letter (correct_answer: "C") or a 1-based position
  // (correct_answer_position: 3).
  const LETTERS = ['A', 'B', 'C', 'D'];
  let correctLetter = null;
  if (typeof data.correct_answer === 'string' && LETTERS.includes(data.correct_answer.trim().toUpperCase())) {
    correctLetter = data.correct_answer.trim().toUpperCase();
  } else if (data.correct_answer_position != null) {
    const pos = Number(data.correct_answer_position);
    if (pos >= 1 && pos <= 4) correctLetter = LETTERS[pos - 1];
  }

  // Merge provided timing over defaults.
  const pick = (v, d) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  const t = {
    question_start: pick(data.question_start, DEFAULT_TIMING.question_start),
    question_end: pick(data.question_end, DEFAULT_TIMING.question_end),
    answers_start: pick(data.answers_start, DEFAULT_TIMING.answers_start),
    wrong_answers_end: pick(data.wrong_answers_end ?? data.answers_end, DEFAULT_TIMING.wrong_answers_end),
    correct_answer_end: pick(data.correct_answer_end, DEFAULT_TIMING.correct_answer_end),
    explanation_start: pick(data.explanation_start, DEFAULT_TIMING.explanation_start),
    explanation_end: pick(data.explanation_end, DEFAULT_TIMING.explanation_end),
  };

  // Build enable expressions:
  //  - question shown question_start..question_end
  //  - correct answer shown answers_start..correct_answer_end (stays after wrong ones vanish)
  //  - wrong answers shown answers_start..wrong_answers_end (then removed)
  //  - explanation shown explanation_start..explanation_end
  const timing = {
    question: timingExpr(t.question_start, t.question_end),
    correctAnswer: timingExpr(t.answers_start, t.correct_answer_end),
    wrongAnswers: timingExpr(t.answers_start, t.wrong_answers_end),
    explanation: timingExpr(t.explanation_start, t.explanation_end),
  };

  // Optional per-request geometry overrides for the explanation block.
  const explGeom = {
    x: pick(data.explanation_x, GEOMETRY.explanation.x),
    y: pick(data.explanation_y, GEOMETRY.explanation.y),
    max_width: pick(data.explanation_max_width, GEOMETRY.explanation.max_width),
    font_size: pick(data.explanation_font_size, GEOMETRY.explanation.font_size),
    min_font_size: pick(data.explanation_min_font_size, GEOMETRY.explanation.min_font_size),
    max_lines: pick(data.explanation_max_lines, GEOMETRY.explanation.max_lines),
  };

  return { question, answers, explanation, correctLetter, timing, explGeom, raw: data };
}

// ------------------------------------------------------------------
// POST /render
// ------------------------------------------------------------------
app.post('/render', upload.single('video'), async (req, res) => {
  const job = crypto.randomBytes(6).toString('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `quiz_${job}_`));
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

  try {
    if (!req.file) return res.status(400).json({ error: 'MISSING_VIDEO_FILE' });

    const parsed = extractData(req);
    const { question, answers, explanation, correctLetter, timing, explGeom } = parsed;
    if (!question || typeof question !== 'string') {
      cleanup();
      return res.status(400).json({ error: 'MISSING_QUESTION' });
    }
    for (const k of ['A', 'B', 'C', 'D']) {
      if (!answers[k] || typeof answers[k] !== 'string') {
        cleanup();
        return res.status(400).json({ error: `MISSING_ANSWER_${k}` });
      }
    }

    // ---- fit question ----
    const qFit = fitText(question.trim(), {
      font_size: GEOMETRY.question.font_size,
      min_font_size: GEOMETRY.question.min_font_size,
      max_width: GEOMETRY.question.max_width,
      max_lines: GEOMETRY.question.max_lines,
    });
    if (!qFit) {
      cleanup();
      return res.status(422).json({ error: 'QUESTION_DOES_NOT_FIT', detail: 'Question too long for the question frame even at min font size.' });
    }

    // ---- fit answers ----
    const answerFits = {};
    for (const k of ['A', 'B', 'C', 'D']) {
      const g = GEOMETRY.answers[k];
      const fit = fitText(answers[k].trim(), {
        font_size: g.font_size,
        min_font_size: g.min_font_size,
        max_width: g.max_width,
        max_lines: g.max_lines,
      });
      if (!fit) {
        cleanup();
        return res.status(422).json({ error: `ANSWER_${k}_DOES_NOT_FIT`, detail: `Answer ${k} too long for its frame even at min font size.` });
      }
      answerFits[k] = fit;
    }

    // ---- build filters ----
    let filters = [];
    filters = filters.concat(
      buildBlockFilters(qFit.lines, qFit.fontSize, GEOMETRY.question.x, GEOMETRY.question.y, tmpDir, 'q', timing.question)
    );
    for (const k of ['A', 'B', 'C', 'D']) {
      const g = GEOMETRY.answers[k];
      // Correct answer stays until correct_answer_end; wrong ones vanish at wrong_answers_end.
      const enable = (k === correctLetter) ? timing.correctAnswer : timing.wrongAnswers;
      filters = filters.concat(
        buildBlockFilters(answerFits[k].lines, answerFits[k].fontSize, g.x, g.y, tmpDir, k, enable)
      );
    }

    // ---- explanation (optional) ----
    if (explanation && typeof explanation === 'string' && explanation.trim()) {
      const eFit = fitText(explanation.trim(), {
        font_size: explGeom.font_size,
        min_font_size: explGeom.min_font_size,
        max_width: explGeom.max_width,
        max_lines: explGeom.max_lines,
      });
      if (!eFit) {
        cleanup();
        return res.status(422).json({ error: 'EXPLANATION_DOES_NOT_FIT', detail: 'Explanation too long for its area even at min font size.' });
      }
      filters = filters.concat(
        buildBlockFilters(eFit.lines, eFit.fontSize, explGeom.x, explGeom.y, tmpDir, 'expl', timing.explanation)
      );
    }

    const filterComplex = filters.join(',');
    const inputPath = req.file.path;
    const outputPath = path.join(tmpDir, 'output.mp4');

    // ---- run ffmpeg ----
    // Keep template duration, audio and design intact; only overlay text.
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', filterComplex,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];

    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', (code) => {
      fs.unlink(inputPath, () => {});
      if (code !== 0 || !fs.existsSync(outputPath)) {
        console.error(`[${job}] ffmpeg failed (code ${code}):\n${stderr.slice(-2000)}`);
        cleanup();
        return res.status(500).json({ error: 'FFMPEG_FAILED', detail: stderr.slice(-1000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="quiz_${job}.mp4"`);
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on('close', cleanup);
      stream.on('error', cleanup);
    });

    ff.on('error', (err) => {
      console.error(`[${job}] failed to start ffmpeg: ${err.message}`);
      cleanup();
      res.status(500).json({ error: 'FFMPEG_NOT_AVAILABLE', detail: err.message });
    });
  } catch (err) {
    cleanup();
    const known = ['INVALID_PAYLOAD_JSON'];
    const msg = err && err.message ? err.message : 'UNKNOWN_ERROR';
    console.error(`[${job}] error: ${msg}`);
    res.status(known.includes(msg) ? 400 : 500).json({ error: msg });
  }
});

// Health check for Railway
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.json({ service: 'quiz-ffmpeg-service', ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`quiz-ffmpeg-service listening on :${PORT}`));
