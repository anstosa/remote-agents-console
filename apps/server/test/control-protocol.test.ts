import { describe, expect, it } from 'vitest';
import { ControlProtocolParser, decodeControlOutput, type ControlEvent } from '../src/tmux/control-protocol.js';

// collect every event a scripted byte stream produces
function collect(chunks: Array<Buffer | string>): ControlEvent[] {
  const events: ControlEvent[] = [];
  const parser = new ControlProtocolParser(event => events.push(event));
  for (const chunk of chunks) parser.push(typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk);
  return events;
}

describe('decodeControlOutput', () => {
  it('decodes three-digit octal escapes to their byte', () => {
    // ESC (0x1b) is \033, backslash (0x5c) is \134
    expect([...decodeControlOutput('a\\033b')]).toEqual([0x61, 0x1b, 0x62]);
    expect([...decodeControlOutput('\\134')]).toEqual([0x5c]);
  });

  it('passes printable ASCII and bytes >= 0x80 through verbatim', () => {
    expect(decodeControlOutput('hello').toString('utf8')).toBe('hello');
    // a euro sign already delivered as raw continuation bytes, not escaped
    expect([...decodeControlOutput('\u00e2\u0082\u00ac')]).toEqual([0xe2, 0x82, 0xac]);
  });

  it('leaves a backslash that is not a complete octal escape verbatim', () => {
    // too few following chars, and a run of three where one is not an octal digit
    expect([...decodeControlOutput('\\9')]).toEqual([0x5c, 0x39]);
    expect([...decodeControlOutput('\\389')]).toEqual([0x5c, 0x33, 0x38, 0x39]);
  });
});

describe('ControlProtocolParser', () => {
  it('matches %end to its %begin by sequence number', () => {
    const events = collect(['%begin 111 7 0\n', 'line one\n', '%end 111 7 1\n']);
    expect(events).toEqual([{ type: 'block', ok: true, lines: ['line one'] }]);
  });

  it('does not let a captured line beginning with %end close a block', () => {
    // the pane content itself contains a %end line with a different command number
    const events = collect([
      '%begin 111 7 0\n',
      'first\n',
      '%end 111 99 1\n',
      'second\n',
      '%end 111 7 1\n'
    ]);
    expect(events).toEqual([{ type: 'block', ok: true, lines: ['first', '%end 111 99 1', 'second'] }]);
  });

  it('reports %error as a failed block', () => {
    const events = collect(['%begin 12 4 0\n', 'boom\n', '%error 12 4 1\n']);
    expect(events).toEqual([{ type: 'block', ok: false, lines: ['boom'] }]);
  });

  it('decodes a multi-byte character split across two %output lines at the byte level', () => {
    // € (U+20AC) is E2 82 AC; the pty read split it after the first byte, so tmux
    // emitted two %output notifications with octal-escaped bytes. The framer surfaces the
    // raw value; decoding each and concatenating the bytes must reassemble the character.
    const events = collect(['%output %1 \\342\n', '%output %1 \\202\\254\n']);
    expect(events).toHaveLength(2);
    const bytes = Buffer.concat(events.map(event => (event.type === 'output' ? decodeControlOutput(event.data) : Buffer.alloc(0))));
    expect(bytes.toString('utf8')).toBe('€');
    expect(events.map(event => event.type === 'output' && event.pane)).toEqual(['%1', '%1']);
  });

  it('reassembles a %output line split across two chunks', () => {
    const events = collect(['%output %2 hel', 'lo\n']);
    expect(events).toEqual([{ type: 'output', pane: '%2', data: 'hello' }]);
  });

  it('emits %pause for its pane so subscribers can re-seed', () => {
    expect(collect(['%pause %3\n'])).toEqual([{ type: 'pause', pane: '%3' }]);
  });

  it('ends every subscriber on %exit with a reason', () => {
    // bare %exit falls back to a default reason; a trailing reason is carried through
    expect(collect(['%exit\n'])).toEqual([{ type: 'exit', reason: 'server exited' }]);
    expect(collect(['%exit killed\n'])).toEqual([{ type: 'exit', reason: 'killed' }]);
  });

  it('surfaces a %layout-change with its window id so the viewer re-asserts its Size claim', () => {
    // window id first, then layout, visible-layout and flags — only the window matters here
    expect(collect(['%layout-change @1 b3f2,80x24,0,0,1 b3f2,80x24,0,0,1 *\n'])).toEqual([
      { type: 'layout', window: '@1' }
    ]);
  });

  it('surfaces a %window-close as a layout change so the viewer re-checks its pane', () => {
    // a pane killed alone in its window closes the window; the viewer re-clamps and, finding
    // its pane gone, ends the stream with "pane closed"
    expect(collect(['%window-close @3\n'])).toEqual([{ type: 'layout', window: '@3' }]);
  });

  it('surfaces a %unlinked-window-close the same as a window close', () => {
    // tmux reports a background window's close (a Console shell exiting on its own, or killed)
    // as %unlinked-window-close, not %window-close; the viewer must re-check its pane either way
    expect(collect(['%unlinked-window-close @4\n'])).toEqual([{ type: 'layout', window: '@4' }]);
  });

  it('surfaces a %subscription-changed by its name so the viewer re-clamps', () => {
    // only the name routes the change; the value that follows is not parsed
    expect(collect(['%subscription-changed rac-clients @1 : 190x50 80x24\n'])).toEqual([
      { type: 'subscription', name: 'rac-clients' }
    ]);
    expect(collect(['%subscription-changed rac-clients\n'])).toEqual([
      { type: 'subscription', name: 'rac-clients' }
    ]);
  });

  it('surfaces a %paste-buffer-changed by the buffer name', () => {
    expect(collect(['%paste-buffer-changed buffer0\n'])).toEqual([{ type: 'paste-buffer', name: 'buffer0' }]);
  });

  it('ignores notifications it does not act on', () => {
    expect(collect(['%window-add @2\n', '%client-detached other\n', '%output %1 x\n'])).toEqual([
      { type: 'output', pane: '%1', data: 'x' }
    ]);
  });

  it('treats %output-looking content inside a block as reply text, not a notification', () => {
    const events = collect(['%begin 1 2 0\n', '%output %9 not-a-notification\n', '%end 1 2 0\n']);
    expect(events).toEqual([{ type: 'block', ok: true, lines: ['%output %9 not-a-notification'] }]);
  });
});
