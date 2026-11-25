/**
 * #1934 reproduction: repeated inline grow/shrink rounds drift the row
 * addressing, so a later sparse diff paints at the wrong offset (or skips a
 * reachable row entirely). On screen that is a torn row — two frames' text
 * sharing one line, e.g. a status field's tail stuck to new output — which is
 * exactly the residue in the 2026-11-25 field screenshot.
 *
 * Root cause (PR #1949): `anchoredPad` records how many rows the anchored
 * shrink repaint left in scrollback. Every later shrink recomputes
 * `scrollbackRows` from the height formula and ignores the pad, so once the
 * pad is deeper than the formula the viewportY floor shrinks and rows that are
 * still unreachable get addressed as if they were live. A full reset does not
 * clear the pad either, so the drift survives across resets.
 *
 * Run: node --import tsx/esm scripts/repro-1934-multi-shrink.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, Box, Text }, { settled, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('./lib/term-test.mjs'),
  ])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const COLS_DEFAULT = 40
const ROWS_DEFAULT = 43
const TALL_EXTRA = 12

const frame = (count: number, tail: string): string[] => [
  ...Array.from({ length: count - 1 }, (_, index) => `row-${String(index).padStart(2, '0')}`),
  tail,
]

/** A viewport row is clean when it is blank or exactly one frame row. */
const TORN = /row-\d\d.*row-\d\d|row-\d\d.*TAIL-|TAIL-.*row-\d\d/

async function runSequence(sequence: number[], COLS = COLS_DEFAULT, ROWS = ROWS_DEFAULT): Promise<void> {
  const target = sequence.at(-1)!
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
      term.write(String(chunk), cb)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }

  let lines: string[] = []
  const listeners = new Set<() => void>()
  const setLines = (next: string[]): void => {
    lines = next
    for (const listener of listeners) listener()
  }
  function LinesView(): React.ReactNode {
    const snapshot = React.useSyncExternalStore(
      listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => lines,
    )
    return (
      <Box flexDirection="column">
        {snapshot.map((text, index) => (
          <Text key={index}>{text}</Text>
        ))}
      </Box>
    )
  }

  const instance = await render(<LinesView />, {
    stdout: new FakeStdout() as never,
    stdin: new FakeStdin() as never,
    stderr: new FakeStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  const label = `${COLS}x${ROWS} sequence=${sequence.join(',')}`
  const settle = async (what: string, pred: () => boolean): Promise<void> => {
    // Tall frames on a short viewport go through the full-reset branch, which
    // is slower than a sparse diff: give the step its own budget instead of
    // the shared 4s default.
    const ok = await settled(pred, { timeoutMs: 12_000 })
    if (!ok) check(`settle: ${label} ${what}`, false, 'never appeared before the settle timeout')
  }

  for (const [step, height] of sequence.entries()) {
    const tail = `TAIL-${step}`
    setLines(frame(height, tail))
    await settle(`step ${step} painted`, () => viewportLines(term, ROWS).includes(tail))
  }

  const buffer = term.buffer.active
  const viewport = viewportLines(term, ROWS)
  const scrollback = Array.from(
    { length: buffer.baseY },
    (_, row) => (buffer.getLine(row)?.translateToString(true) ?? '').replace(/\s+$/, ''),
  ).filter(line => line.trim() !== '')

  const tailRow = viewport.findIndex(line => line.startsWith('TAIL-'))
  check(`${label}: tail row is on screen`, tailRow >= 0, JSON.stringify(viewport.slice(0, 4)))
  if (tailRow >= 0) {
    check(
      `${label}: tail sits directly under its frame row`,
      viewport[tailRow - 1] === `row-${String(target - 2).padStart(2, '0')}`,
      `above=${JSON.stringify(viewport[tailRow - 1])}`,
    )
  }

  const torn = viewport.filter(line => line !== '' && TORN.test(line))
  check(`${label}: no torn rows (two frames sharing one line)`, torn.length === 0, JSON.stringify(torn.slice(0, 4)))

  // A frame taller than the viewport is repainted through the reset branches,
  // which reprint by design (the transcript above stays in scrollback), so a
  // duplicate is only a defect when the frame fits: there the anchored tail
  // repaint is supposed to keep the scrollback originals authoritative.
  if (target <= ROWS) {
    const seen = new Map<string, number>()
    for (const line of [...scrollback, ...viewport]) if (line.trim() !== '') seen.set(line, (seen.get(line) ?? 0) + 1)
    const duplicates = [...seen].filter(([, count]) => count > 1)
    check(
      `${label}: no frame row printed twice (scrollback + viewport)`,
      duplicates.length === 0,
      duplicates.slice(0, 4).map(([text, count]) => `${text}x${count}`).join(' '),
    )
  }

  instance.unmount()
  term.dispose()
}

// 40x43 matches verify-inline-shrink-to-fit, and is the shape this defect
// needs: the frame fits the viewport after the shrink, so log-update takes the
// anchored tail repaint whose pad bookkeeping drifts. A frame that stays
// TALLER than the viewport fails differently (it cannot be addressed at all —
// a separate hole, see the issue thread), so it is deliberately not asserted
// here: this script must be a clean red/green for #1934 alone.
for (const [cols, rows] of [[40, 43]]) {
  for (const sequence of [[55, 33, 50, 30], [55, 42, 50, 41], [55, 43, 30]]) {
    await runSequence(sequence, cols, rows)
  }
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
