import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { timeoutArg, pickPath, unknownArgsMessage, rejectUnknownArgs } from '../common/tool-args';
import { SvnService } from '../tools/svn-service';

describe('path/target — the sibling tools name the same thing differently', () => {
  it('takes either key', () => {
    expect(pickPath('svn_list', { path: '/a' })).toBe('/a');
    expect(pickPath('svn_list', { target: '/a' })).toBe('/a');
    expect(pickPath('svn_list', { path: '/a', target: '/a' })).toBe('/a');
  });

  it('refuses the two keys with different values instead of picking one', () => {
    expect(() => pickPath('svn_update', { path: '/a', target: '/b' })).toThrow(/aliases.*different values/);
  });

  it('stays optional where it was optional', () => {
    expect(pickPath('svn_list', {})).toBeUndefined();
  });

  it('stays required where it was required (cat/blame)', () => {
    expect(() => pickPath('svn_cat', {}, true)).toThrow(/`target` \(or its alias `path`\) is required/);
    expect(pickPath('svn_cat', { path: '/f.sql' }, true)).toBe('/f.sql');
  });

  it('every tool with a path parameter resolves it through pickPath', () => {
    const indexSrc = fs.readFileSync(path.join(process.cwd(), 'index.ts'), 'utf8');
    for (const tool of ['svn_info', 'svn_status', 'svn_log', 'svn_diff', 'svn_update', 'svn_cleanup', 'svn_list']) {
      expect(indexSrc).toContain(`pickPath("${tool}", args)`);
    }
    for (const tool of ['svn_cat', 'svn_blame']) {
      expect(indexSrc).toContain(`pickPath("${tool}", args, true)`);
    }
  });
});

describe('unknown keys — refused, never silently dropped', () => {
  const shape = { target: z.string().optional(), recursive: z.boolean().optional() };

  it('names the unknown key and lists the accepted ones', () => {
    const msg = unknownArgsMessage('svn_list', shape, { target: '/a', foo: 1 });
    expect(msg).toContain("'foo'");
    expect(msg).toContain('Accepted: target, recursive');
  });

  it('passes known keys and absent arguments', () => {
    expect(unknownArgsMessage('svn_list', shape, { target: '/a', recursive: true })).toBeUndefined();
    expect(unknownArgsMessage('svn_list', shape, undefined)).toBeUndefined();
  });

  it('says so for a tool that takes nothing', () => {
    expect(unknownArgsMessage('svn_health_check', {}, { x: 1 })).toContain('takes no parameters');
  });

  it('answers tools/call with InvalidParams before the SDK sees it', async () => {
    const sent: any[] = [];
    const dispatched: any[] = [];
    const transport: any = {
      start: async () => {},
      send: async (m: any) => { sent.push(m); },
      close: async () => {},
    };
    rejectUnknownArgs(transport, new Map([['svn_list', shape]]));
    transport.onmessage = (m: any) => dispatched.push(m); // o Protocol instala antes do start
    await transport.start();

    transport.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'svn_list', arguments: { foo: 1 } } });
    transport.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'svn_list', arguments: { target: '/a' } } });
    transport.onmessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(sent[0].error.message).toContain("'foo'");
    expect(dispatched.map(m => m.id)).toEqual([2, 3]);
  });
});

describe('timeout — a string is accepted only if it is a clean positive integer', () => {
  it('accepts a number and a digit-only string', () => {
    expect(timeoutArg.parse(180000)).toBe(180000);
    expect(timeoutArg.parse('180000')).toBe(180000);
  });

  it.each(['180000ms', '12.5', 'abc', '', '-5', '0', ' 5', '1e5'])('refuses %p', (v) => {
    expect(timeoutArg.safeParse(v).success).toBe(false);
  });

  it.each([0, -1, 1.5])('refuses the number %p', (v) => {
    expect(timeoutArg.safeParse(v).success).toBe(false);
  });
});

describe('svn_list — the per-call timeout reaches the command', () => {
  it('times out at the given value instead of the global default', async () => {
    // node no lugar do svn: sobe em dezenas de ms, entao 1 ms so pode estourar
    // se o timeout da chamada chegou ao executeSvnCommand.
    const svc = new SvnService({ svnPath: process.execPath, workingDirectory: process.cwd() });
    await expect(svc.list(undefined, { timeout: 1 })).rejects.toThrow(/Command timeout after 1ms/);
  });
});
