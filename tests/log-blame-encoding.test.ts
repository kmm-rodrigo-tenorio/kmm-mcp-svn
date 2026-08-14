import { describe, it, expect } from '@jest/globals';
import { parseLogOutput, parseBlameOutput, describeEncoding, matchLines } from '../common/utils';

/**
 * All fixtures below are the shapes svn really emits, captured from the CT-e and
 * Contrato de Transporte trees. The point of each test is a defect that the plain
 * text form of the same command would have produced.
 */

const LOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="641855">
<author>rodrigo.tenorio</author>
<date>2026-08-12T18:59:12.000000Z</date>
<paths>
<path action="M" kind="file">/Software/_dev/Modulos/Fiscal/x &amp; y/arquivo.cfc</path>
</paths>
<msg>Bug 38260 - Corrige alias fora de escopo</msg>
</logentry>
<logentry revision="641849">
<author>svnadmin</author>
<date>2026-08-12T18:59:44.000000Z</date>
<paths>
<path action="A" copyfrom-path="/Software/_dev/Modulos/Transporte e Logistica/Contrato de Transporte/_baseline/Branches/AT-CIOT-DELPOZO" copyfrom-rev="641848" kind="dir">/Software/_dev/Modulos/Transporte e Logistica/Contrato de Transporte/_baseline/Branches/Bug 38260</path>
</paths>
<msg>Criacao do branch</msg>
</logentry>
</log>`;

describe('parseLogOutput over --xml', () => {
  const entries = parseLogOutput(LOG_XML);

  it('reads revision, author and message', () => {
    expect(entries).toHaveLength(2);
    expect(entries[0].revision).toBe(641855);
    // The plain form pads nothing here, but the author is the field a truncating
    // parser would damage, so assert it whole.
    expect(entries[0].author).toBe('rodrigo.tenorio');
    expect(entries[0].message).toContain('alias fora de escopo');
  });

  it('fills the copy origin, which the old parser never did', () => {
    // This is the check that stops a fix being written against the wrong code: a
    // released version branches off `bugfixes`, where the defect may not exist.
    const copy = entries[1].changedPaths!.find(p => p.copyFromPath)!;
    expect(copy.copyFromPath).toContain('AT-CIOT-DELPOZO');
    expect(copy.copyFromRev).toBe(641848);
    expect(copy.action).toBe('A');
  });

  it('unescapes entities in changed paths', () => {
    expect(entries[0].changedPaths![0].path).toContain('x & y');
    expect(entries[0].changedPaths![0].path).not.toContain('&amp;');
  });

  it('leaves changedPaths undefined without -v instead of inventing an empty list', () => {
    const noPaths = parseLogOutput(
      `<log><logentry revision="1"><author>a</author><date>d</date><msg>m</msg></logentry></log>`
    );
    expect(noPaths[0].changedPaths).toBeUndefined();
  });

  it('returns nothing for empty or non-XML input', () => {
    expect(parseLogOutput('')).toEqual([]);
    expect(parseLogOutput('r1 | author | date | 1 line')).toEqual([]);
  });
});

describe('parseBlameOutput - the author must not be truncated', () => {
  const BLAME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<blame>
<target path="cfc_emissao_documentos.cfc">
<entry line-number="719">
<commit revision="625811">
<author>rodrigo.tenorio</author>
<date>2026-01-15T10:00:00.000000Z</date>
</commit>
</entry>
<entry line-number="722">
<commit revision="640877">
<author>fioravante.manfron</author>
<date>2026-08-06T22:03:11.320796Z</date>
</commit>
</entry>
<entry line-number="900">
</entry>
</target>
</blame>`;

  const attribution = parseBlameOutput(BLAME_XML);

  it('keeps the whole username', () => {
    // The plain text form pads the author into 10 characters: it reports
    // `fioravante` and `rodrigo.te`. A truncated username reads like a real
    // answer, which is why the XML form is the only one used.
    expect(attribution.get(722)!.author).toBe('fioravante.manfron');
    expect(attribution.get(719)!.author).toBe('rodrigo.tenorio');
  });

  it('maps line number to revision and date', () => {
    expect(attribution.get(722)!.revision).toBe(640877);
    expect(attribution.get(722)!.date).toContain('2026-08-06');
  });

  it('skips a line with no commit instead of inventing revision 0', () => {
    expect(attribution.has(900)).toBe(false);
  });

  it('returns an empty map for empty input', () => {
    expect(parseBlameOutput('').size).toBe(0);
  });
});

describe('describeEncoding - say it before anyone edits the file', () => {
  it('flags a latin1 file as NOT UTF-8 and counts the high bytes', () => {
    // 0xD3 is 'O' with acute in latin1 and an invalid UTF-8 lead byte on its own.
    const latin1 = Buffer.from([0x50, 0x52, 0x4f, 0x50, 0xd3, 0x53, 0x49, 0x54, 0x4f]);
    const probe = describeEncoding(latin1);
    expect(probe.isUtf8).toBe(false);
    expect(probe.highBytes).toBe(1);
    expect(probe.note).toContain('NOT UTF-8');
    expect(probe.note).toContain('byte-exact');
  });

  it('recognizes real UTF-8 with accents', () => {
    const probe = describeEncoding(Buffer.from('PROPÓSITO', 'utf8'));
    expect(probe.isUtf8).toBe(true);
    expect(probe.highBytes).toBe(2);
    expect(probe.note).toContain('UTF-8');
    expect(probe.note).not.toContain('NOT');
  });

  it('calls pure ASCII safe to edit as text', () => {
    const probe = describeEncoding(Buffer.from('select 1 from dual', 'ascii'));
    expect(probe.highBytes).toBe(0);
    expect(probe.note).toContain('ASCII only');
  });
});

describe('matchLines', () => {
  const text = ['um', 'dois x.operacao_id', 'tres', 'quatro', 'cinco x.num_romaneio'].join('\n');

  it('numbers lines from 1', () => {
    expect(matchLines(text, 'x\\.operacao_id')).toEqual([{ line: 2, content: 'dois x.operacao_id' }]);
  });

  it('includes context without duplicating overlapping lines', () => {
    const hits = matchLines(text, 'x\\.', 1);
    expect(hits.map(h => h.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns nothing when the pattern does not match', () => {
    expect(matchLines(text, 'inexistente')).toEqual([]);
  });
});
