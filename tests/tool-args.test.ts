import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { timeoutArg, pickPath, unknownArgsMessage, rejectUnknownArgs, MAX_TIMEOUT_MS } from '../common/tool-args';
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
    // svn_mergeinfo/svn_merge/svn_resolve: alvo obrigatorio — sem ele o svn usaria o cwd,
    // que e a raiz da working copy. A origem e `source`, parametro proprio.
    for (const tool of ['svn_cat', 'svn_blame', 'svn_mergeinfo', 'svn_merge', 'svn_resolve']) {
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

  it('answers tools/call with InvalidParams through the real SDK server and stdio transport', async () => {
    // McpServer e StdioServerTransport de verdade: se o SDK deixar de instalar o
    // onmessage antes do start(), o embrulho e sobrescrito e este teste falha.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new McpServer({ name: 't', version: '0' });
    const handled: unknown[] = [];
    server.tool('svn_list', 'list', shape, async (args) => {
      handled.push(args);
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const transport = new StdioServerTransport(stdin, stdout);
    rejectUnknownArgs(transport, new Map([['svn_list', shape]]));
    await server.connect(transport);

    const replies = new Map<number, any>();
    let buf = '';
    stdout.on('data', (c) => {
      buf += c;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const m = JSON.parse(buf.slice(0, i));
        replies.set(m.id, m);
      }
    });
    const call = (id: number, args: object) => stdin.write(JSON.stringify(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'svn_list', arguments: args } }) + '\n');
    call(1, { target: '/a', foo: 1 });
    call(2, { target: '/a' });
    while (replies.size < 2) await new Promise(r => setTimeout(r, 10));
    await server.close();

    expect(replies.get(1).error.code).toBe(-32602);
    expect(replies.get(1).error.message).toContain("unknown parameter(s) 'foo'");
    expect(replies.get(2).result.content[0].text).toBe('ok');
    expect(handled).toEqual([{ target: '/a' }]);
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

  // Acima de 2^31-1 o setTimeout do Node dispara em 1 ms: o comando morreria na hora.
  it('accepts the setTimeout ceiling, as number and as text', () => {
    expect(timeoutArg.parse(MAX_TIMEOUT_MS)).toBe(2147483647);
    expect(timeoutArg.parse('2147483647')).toBe(2147483647);
  });

  it.each([2147483648, '2147483648', '99999999999999999999'])('refuses %p above the ceiling', (v) => {
    const r = timeoutArg.safeParse(v);
    expect(r.success).toBe(false);
    expect(r.error!.message).toContain('at most 2147483647 ms');
  });

  it('is published by tools/list as number OR digit string, as the server accepts', async () => {
    // O schema publicado e o contrato que cliente e modelo leem. Um `.pipe` no ramo texto
    // virava `allOf [string, integer]` (insatisfazivel) sem nenhum teste ficar vermelho.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new McpServer({ name: 't', version: '0' });
    server.tool('svn_list', 'list', { timeout: timeoutArg.optional() }, async () => ({ content: [] }));
    await server.connect(new StdioServerTransport(stdin, stdout));
    const reply = await new Promise<any>((resolve) => {
      let buf = '';
      stdout.on('data', (c) => {
        buf += c;
        const i = buf.indexOf('\n');
        if (i >= 0) resolve(JSON.parse(buf.slice(0, i)));
      });
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    });
    await server.close();

    expect(reply.result.tools[0].inputSchema.properties.timeout).toEqual({
      anyOf: [
        { type: 'integer', exclusiveMinimum: 0, maximum: 2147483647 },
        { type: 'string', pattern: '^[1-9]\\d*$' }
      ]
    });
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
