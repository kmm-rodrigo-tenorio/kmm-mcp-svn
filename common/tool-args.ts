import { z } from "zod";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Teto do setTimeout do Node (2^31-1 ms, ~24,8 dias): acima disso ele dispara em 1 ms
// e o comando morreria na hora com uma mensagem de timeout enorme.
export const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_MSG = `timeout must be at most ${MAX_TIMEOUT_MS} ms`;

/**
 * Timeout por chamada, em ms. Aceita numero ou texto que seja SO digitos ("180000"):
 * o cliente as vezes manda o valor como string, e antes disso a chave era descartada
 * calada. Texto que nao converte limpo ("180000ms", "12.5", "", "-5") e erro. O teto
 * vale para os dois ramos; texto longo demais vira numero acima dele e cai junto.
 *
 * ⚠ No ramo texto o teto e `.refine`, nao `.pipe`: o zod-to-json-schema publica um
 * pipe como `allOf [string, integer]`, que nenhum valor satisfaz, e o `tools/list`
 * passaria a dizer que texto nao e aceito. O refine publica so a entrada.
 */
export const timeoutArg = z.union([
  z.number().int().positive().max(MAX_TIMEOUT_MS, MAX_TIMEOUT_MSG),
  z.string()
    .regex(/^[1-9]\d*$/, 'timeout as text must be digits only — a positive whole number of milliseconds, e.g. "180000"')
    .transform(Number)
    .refine(n => n <= MAX_TIMEOUT_MS, MAX_TIMEOUT_MSG)
]);

/** Alias do parametro de caminho: as tools irmas chamam o mesmo conceito de `path` ou de `target`. */
export const pathAliasArg = (of: 'path' | 'target') =>
  z.string().optional().describe(`Alias of \`${of}\` — same meaning, pass one or the other.`);

/**
 * Resolve `path`/`target` num caminho so. Valores diferentes nas duas chaves sao erro:
 * escolher um em silencio seria operar no lugar que a chamada talvez nao quis.
 */
export function pickPath(
  tool: string,
  args: { path?: string; target?: string },
  required = false
): string | undefined {
  if (args.path !== undefined && args.target !== undefined && args.path !== args.target) {
    throw new Error(
      `Invalid arguments for tool ${tool}: \`path\` and \`target\` are aliases and came with ` +
      `different values ('${args.path}' vs '${args.target}'). Pass only one.`
    );
  }
  const value = args.path ?? args.target;
  if (required && value === undefined) {
    throw new Error(`Invalid arguments for tool ${tool}: \`target\` (or its alias \`path\`) is required.`);
  }
  return value;
}

/** Mensagem de erro para chaves fora do shape da tool, ou undefined se todas sao conhecidas. */
export function unknownArgsMessage(tool: string, shape: z.ZodRawShape, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const unknown = Object.keys(args).filter(k => !Object.prototype.hasOwnProperty.call(shape, k));
  if (unknown.length === 0) return undefined;
  const accepted = Object.keys(shape);
  return `Invalid arguments for tool ${tool}: unknown parameter(s) ${unknown.map(k => `'${k}'`).join(', ')}. ` +
    (accepted.length ? `Accepted: ${accepted.join(', ')}.` : `This tool takes no parameters.`);
}

/**
 * Recusa `tools/call` com chave desconhecida, antes de o SDK ver a chamada.
 *
 * O SDK 1.6.1 monta `z.object(shape)` nao estrito em `server.tool`: chave fora do shape
 * e removida sem erro e o handler recebe os argumentos ja sem ela. Foi assim que
 * `svn_list` chamado com `path` listou a RAIZ da working copy, e `svn_update` com
 * `target` atualizaria a working copy inteira. A conferencia tem de olhar os
 * argumentos crus, entao fica no transporte.
 *
 * Embrulha o `onmessage` dentro de `start()`: o Protocol instala o `onmessage` e so
 * depois chama `start()` (contrato do Transport), entao nenhuma mensagem escapa.
 */
export function rejectUnknownArgs(transport: Transport, shapes: Map<string, z.ZodRawShape>): void {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const dispatch = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage) => {
      if ('method' in message && message.method === 'tools/call' && 'id' in message) {
        const params = (message.params ?? {}) as { name?: string; arguments?: unknown };
        const shape = params.name !== undefined ? shapes.get(params.name) : undefined;
        const error = shape && unknownArgsMessage(params.name!, shape, params.arguments);
        if (error) {
          void transport.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: ErrorCode.InvalidParams, message: error }
          });
          return;
        }
      }
      dispatch?.(message);
    };
    return start();
  };
}
